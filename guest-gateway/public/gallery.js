// guest-gateway/public/gallery.js
// 「みんなの写真」: アルバム全体のサムネイル一覧 → PhotoSwipe で拡大・スワイプ・動画再生 → 保存。
// 保存は端末に合わせる(bulk.js): iPhone / iPad は原寸を取得してから共有シートで写真アプリへ
// (1 回目のタップで準備、2 回目で保存。大きな動画は「ファイル」へ)、Android と PC は直接ダウンロード。
// 原寸の先読みはしない(ゲスト全員が見るだけで数 GB になるため)。「まとめて保存」も bulk.js。
// サムネイルは画面に近いものから同時 12 件までに絞って読み込む(窓口の同時配信上限 48 より十分下)。
// 動画は表示中のスライドだけが通信する(窓口の動画・原寸の上限は端末あたり 4 本)。
// 削除は自分の投稿(管理者モードなら全件)だけ、2 回タップで確定。Immich のゴミ箱へ移る。

import PhotoSwipeLightbox from '/vendor/photoswipe/photoswipe-lightbox.esm.min.js';
import {
  BulkError,
  downloadDirectly,
  fetchOriginal,
  fileFor,
  initBulk,
  markSaved,
  saveMode,
  SHARE_MAX_FILE_BYTES,
} from './bulk.js';

// Thumbnails in flight at once; well below the gateway's 48 per device, so 429s are rare and
// failures are mostly "not generated yet" (404 right after an upload).
const THUMB_CONCURRENCY = 12;
// Retry delays (with jitter) for failed thumbnails; generation can take a while under load.
const THUMB_RETRY_MS = [2000, 4000, 8000, 15000, 30000, 60000, 60000, 60000];
// Start loading thumbnails a little before they scroll into view.
const THUMB_ROOT_MARGIN = '600px 0px';
const REFRESH_AFTER_MS = 30_000;
// The second tap on 「削除」 must come within this time.
const DELETE_CONFIRM_MS = 4000;

const $ = (id) => document.getElementById(id);

let assets = [];
// Signature of the rendered list: skip rebuilding thousands of tiles when nothing changed.
let renderedSignature = '';
let lightbox = null;
let loadedAt = 0;
let loading = null;
let onUnauthorized = () => {};
let apiFetch = null;
// { role, canDelete } from the session.
let permissions = { role: 'guest', canDelete: false };
// Prepared original for the share sheet: assetId → File, or 'download' for a video too large
// for it (only the item being saved). The next tap uses it while it still counts as a gesture.
const prepared = new Map();
const mode = saveMode();
let bulk = null;
// Asset whose original the save button is fetching right now (first tap).
let preparingId = null;
// True while the share sheet of a single save is open.
let sharing = false;

function mediaUrl(asset, kind) {
  return `/media/${encodeURIComponent(asset.id)}/${kind}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })
    : '';
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// --- Thumbnails (client-side queue) ---

const thumbQueue = [];
let thumbsInFlight = 0;
// Thumbnails that used up their retries (e.g. Immich's thumbnail job lagging behind a burst).
const failedThumbs = new Set();

function jitter(ms) {
  return Math.round(ms * (0.5 + Math.random()));
}

function enqueueThumb(job) {
  thumbQueue.push(job);
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbsInFlight < THUMB_CONCURRENCY && thumbQueue.length > 0) {
    const job = thumbQueue.shift();
    // Tiles from a previous render are gone; do not spend a request on them.
    if (!job.img.isConnected) continue;
    thumbsInFlight += 1;
    loadThumb(job).finally(() => {
      thumbsInFlight -= 1;
      pumpThumbs();
    });
  }
}

function loadThumb({ img, asset, attempt }) {
  return new Promise((resolve) => {
    img.onload = () => {
      // Thumbnails keep the photo's aspect ratio (verified): the viewer uses it for its size.
      if (img.naturalWidth && img.naturalHeight) {
        asset.aspect = img.naturalWidth / img.naturalHeight;
      }
      resolve();
    };
    img.onerror = () => {
      resolve();
      if (attempt >= THUMB_RETRY_MS.length) {
        // Out of retries: the next refresh (or 「更新」) starts this tile over.
        failedThumbs.add(img);
        return;
      }
      setTimeout(
        () => enqueueThumb({ img, asset, attempt: attempt + 1 }),
        jitter(THUMB_RETRY_MS[attempt]),
      );
    };
    // A new URL per attempt: the browser does not refetch an identical failed src.
    img.src =
      attempt === 0 ? mediaUrl(asset, 'thumbnail') : `${mediaUrl(asset, 'thumbnail')}?r=${attempt}`;
  });
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbObserver.unobserve(entry.target);
      const { img, asset } = entry.target.gwThumb;
      enqueueThumb({ img, asset, attempt: 0 });
    }
  },
  { rootMargin: THUMB_ROOT_MARGIN },
);

function listSignature(list) {
  return list.map((a) => `${a.id}:${a.mine ? 1 : 0}:${a.by ?? ''}`).join('|');
}

/** Show a fresh listing; an unchanged one keeps the current tiles (and their scroll position). */
function renderGrid(fullList) {
  const list = fullList.filter((a) => !deletedIds.has(a.id));
  $('gallery-count').textContent = `${list.length} 件`;
  $('gallery-empty').hidden = list.length > 0;
  const signature = listSignature(list);
  if (signature === renderedSignature) {
    // Same tiles: only give the thumbnails that gave up another chance.
    for (const img of failedThumbs) {
      if (img.isConnected)
        enqueueThumb({ img, asset: img.parentElement.gwThumb.asset, attempt: 0 });
    }
    failedThumbs.clear();
    return;
  }
  renderedSignature = signature;
  assets = list;
  failedThumbs.clear();

  const grid = $('grid');
  thumbObserver.disconnect();
  thumbQueue.length = 0;
  grid.textContent = '';
  const fragment = document.createDocumentFragment();
  assets.forEach((asset, index) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.setAttribute(
      'aria-label',
      `${asset.type === 'video' ? '動画' : '写真'} ${asset.by ? `(${asset.by})` : ''}`,
    );
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    tile.append(img);
    tile.gwThumb = { img, asset };
    if (asset.type === 'video') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = asset.durationMs ? `▶ ${formatDuration(asset.durationMs)}` : '▶';
      tile.append(badge);
    }
    if (asset.mine) {
      const mine = document.createElement('span');
      mine.className = 'mine';
      mine.textContent = '自分';
      tile.append(mine);
    }
    tile.addEventListener('click', () => openViewer(index));
    fragment.append(tile);
  });
  grid.append(fragment);
  for (const tile of grid.children) thumbObserver.observe(tile);
}

// --- Viewer (PhotoSwipe) ---

/** Display size: the long side from Immich, the aspect ratio from what was actually loaded. */
function slideSize(asset) {
  const longSide = Math.max(asset.width || 0, asset.height || 0) || 1200;
  const aspect = asset.aspect ?? (asset.width && asset.height ? asset.width / asset.height : 1);
  return aspect >= 1
    ? { width: longSide, height: Math.round(longSide / aspect) }
    : { width: Math.round(longSide * aspect), height: longSide };
}

function slideData(asset) {
  const size = slideSize(asset);
  if (asset.type === 'video') return { type: 'video', asset, ...size };
  return { src: mediaUrl(asset, 'preview'), msrc: mediaUrl(asset, 'thumbnail'), asset, ...size };
}

function captionText(asset) {
  return [asset.by ? `${asset.by} さん` : '', formatDate(asset.takenAt)]
    .filter(Boolean)
    .join(' ・ ');
}

function saveLabel(asset) {
  if (mode !== 'share') return '保存';
  const ready = prepared.get(asset.id);
  if (ready === 'download') return 'ファイルに保存';
  return ready ? '写真に保存' : '保存';
}

function currentAsset() {
  return lightbox?.pswp?.currSlide?.data.asset ?? null;
}

/** Show the note only while the guest is still on the photo it is about. */
function noteFor(asset, text) {
  if (currentAsset()?.id === asset.id) $('viewer-note').textContent = text;
}

async function onSave(button, asset) {
  if (mode !== 'share') {
    // Android: Downloads (shown in the gallery). PCs: the browser's download folder.
    downloadDirectly(asset);
    markSaved([asset.id]);
    noteFor(
      asset,
      mode === 'download' ? '「ダウンロード」に保存します(ギャラリーにも表示されます)' : '',
    );
    return;
  }
  const ready = prepared.get(asset.id);
  if (ready === 'download') {
    downloadDirectly(asset);
    markSaved([asset.id]);
    prepared.clear();
    noteFor(
      asset,
      '「ファイル」アプリで開き、共有ボタンから「ビデオを保存」で写真アプリに入ります',
    );
    return;
  }
  if (ready) {
    // A second tap while the sheet is open would make share() fail (InvalidStateError) and
    // switch this photo to a Files download. share() stays the first await (the tap's gesture).
    if (sharing) return;
    sharing = true;
    button.disabled = true;
    try {
      await navigator.share({ files: [ready] });
      prepared.clear();
      markSaved([asset.id]);
      const shown = currentAsset();
      if (shown) button.textContent = saveLabel(shown);
    } catch (err) {
      // AbortError = the guest closed the share sheet (keep the file for another try).
      // Anything else: the sheet refused the file; the next tap downloads it instead (a download
      // started here, after the await, would no longer count as the guest's tap).
      if (err?.name !== 'AbortError') {
        prepared.clear();
        prepared.set(asset.id, 'download');
        noteFor(asset, 'もう一度タップすると「ファイル」アプリに保存されます');
        const shown = currentAsset();
        if (shown) button.textContent = saveLabel(shown);
      }
    } finally {
      sharing = false;
      button.disabled = false;
    }
    return;
  }
  // First tap: fetch the original now (the share sheet needs the file before the next tap).
  button.disabled = true;
  button.textContent = '準備中…';
  preparingId = asset.id;
  try {
    const result = await fetchOriginal(asset, { maxBytes: SHARE_MAX_FILE_BYTES });
    prepared.clear();
    // The guest moved on or closed the viewer meanwhile: do not keep the file in memory.
    if (currentAsset()?.id !== asset.id) return;
    if (result.missing) {
      noteFor(asset, 'この写真は削除されています');
    } else if (result.tooLarge) {
      prepared.set(asset.id, 'download');
      noteFor(asset, '大きな動画のため、もう一度タップすると「ファイル」アプリに保存されます');
    } else {
      prepared.set(asset.id, fileFor(asset, result.blob));
      noteFor(asset, 'もう一度タップすると写真アプリに保存できます');
    }
  } catch (err) {
    if (err instanceof BulkError && err.message === 'unauthorized') {
      lightbox.pswp?.close();
      onUnauthorized();
      return;
    }
    noteFor(asset, '取得できませんでした。もう一度お試しください');
  } finally {
    preparingId = null;
    // The guest may have swiped meanwhile: label the button for the photo shown now.
    button.disabled = false;
    const shown = currentAsset();
    if (shown) button.textContent = saveLabel(shown);
  }
}

function canDeleteAsset(asset) {
  return permissions.canDelete && (asset.mine || permissions.role === 'admin');
}

// Ids deleted in this session: hidden from every listing, including one that was already in
// flight when the delete finished.
const deletedIds = new Set();
let confirmTimer = null;

function resetDeleteButton(button) {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  delete button.dataset.confirm;
  button.textContent = '削除';
}

async function onDelete(button, asset) {
  if (button.dataset.confirm !== asset.id) {
    resetDeleteButton(button);
    button.dataset.confirm = asset.id;
    button.textContent = '本当に削除';
    confirmTimer = setTimeout(() => resetDeleteButton(button), DELETE_CONFIRM_MS);
    return;
  }
  resetDeleteButton(button);
  button.disabled = true;
  button.textContent = '削除中…';
  try {
    const res = await apiFetch(`/api/assets/${encodeURIComponent(asset.id)}`, {
      method: 'DELETE',
    });
    if (res.status === 401) {
      lightbox.pswp?.close();
      onUnauthorized();
      return;
    }
    if (res.status === 403) {
      noteFor(asset, 'この写真は削除できません(自分の端末から上げた写真だけ削除できます)');
      return;
    }
    if (!res.ok && res.status !== 404) throw new Error(String(res.status));
    // 404 = already gone (e.g. deleted by the organiser): drop it from the grid all the same.
    deletedIds.add(asset.id);
    lightbox.pswp?.close();
    renderGrid(assets);
    bulk?.refresh();
    $('gallery-status').textContent = '削除しました';
  } catch (err) {
    if (err?.message !== 'closed') noteFor(asset, '削除できませんでした。もう一度お試しください');
  } finally {
    button.disabled = false;
    button.textContent = '削除';
  }
}

// Videos only stream while their slide is shown: neighbours that PhotoSwipe preloads get a
// poster but no src, so they cannot use up the per-device video/original slots.
function startVideo(content) {
  const video = content.element?.querySelector('video');
  if (video && !video.getAttribute('src')) video.src = mediaUrl(content.data.asset, 'video');
}

function stopVideo(video) {
  if (!video?.getAttribute('src')) return;
  video.pause();
  video.removeAttribute('src');
  // Aborts the pending request so the gateway frees the slot.
  video.load();
}

function createVideoContent(content) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pswp__content gw-video';
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.poster = mediaUrl(content.data.asset, 'preview');
  wrapper.append(video);
  return wrapper;
}

/** Fix the slide size if the loaded image's aspect differs, and remember it for next time. */
function correctAspect(content) {
  const img = content?.element;
  if (!(img instanceof HTMLImageElement) || !img.naturalWidth || !img.naturalHeight) return;
  const { asset } = content.data;
  const natural = img.naturalWidth / img.naturalHeight;
  if (Math.abs(natural - content.data.width / content.data.height) < 0.02) return;
  asset.aspect = natural;
  const index = lightbox.options.dataSource.findIndex((item) => item.asset === asset);
  if (index === -1) return;
  Object.assign(lightbox.options.dataSource[index], slideSize(asset));
  lightbox.pswp.refreshSlideContent(index);
}

function setupLightbox() {
  lightbox = new PhotoSwipeLightbox({
    dataSource: [],
    pswpModule: () => import('/vendor/photoswipe/photoswipe.esm.min.js'),
    bgOpacity: 1,
    loop: false,
    closeTitle: '閉じる',
    zoomTitle: '拡大',
    arrowPrevTitle: '前へ',
    arrowNextTitle: '次へ',
    errorMsg: '読み込めませんでした',
  });

  lightbox.on('contentLoad', (event) => {
    const { content } = event;
    if (content.type !== 'video') return;
    event.preventDefault();
    content.element = createVideoContent(content);
  });
  lightbox.on('contentActivate', ({ content }) => {
    if (content.type === 'video') startVideo(content);
    // Preloaded/cached images never fire loadComplete with a slide: check them here too.
    else if (content.element?.complete) correctAspect(content);
  });
  lightbox.on('contentDeactivate', ({ content }) => {
    stopVideo(content.element?.querySelector('video'));
  });
  lightbox.on('loadComplete', ({ content }) => correctAspect(content));
  // PhotoSwipe drops its listeners before destroying slides, so release everything on close.
  lightbox.on('close', () => {
    for (const video of lightbox.pswp.element?.querySelectorAll('video') ?? []) stopVideo(video);
    prepared.clear();
  });

  lightbox.on('uiRegister', () => {
    const { ui } = lightbox.pswp;
    let shownIndex = -1;
    ui.registerElement({
      name: 'gw-save',
      order: 9,
      isButton: true,
      tagName: 'button',
      title: '保存',
      html: '保存',
      onInit: (el, pswp) => {
        el.classList.add('gw-save');
        pswp.on('change', () => {
          // A prepared original (up to hundreds of MB) is only kept for the item on screen.
          if (!prepared.has(pswp.currSlide.data.asset.id)) prepared.clear();
          // While an original is being fetched the (disabled) button keeps saying so.
          el.textContent = preparingId ? '準備中…' : saveLabel(pswp.currSlide.data.asset);
          // refreshSlideContent also fires 'change'; only a real slide change clears the note.
          if (pswp.currIndex !== shownIndex) {
            shownIndex = pswp.currIndex;
            $('viewer-note').textContent = '';
          }
        });
      },
      onClick: (_event, el, pswp) => onSave(el, pswp.currSlide.data.asset),
    });
    ui.registerElement({
      name: 'gw-delete',
      order: 8,
      isButton: true,
      tagName: 'button',
      title: '削除',
      html: '削除',
      onInit: (el, pswp) => {
        el.classList.add('gw-delete');
        pswp.on('change', () => {
          const asset = pswp.currSlide.data.asset;
          el.hidden = !canDeleteAsset(asset);
          if (el.dataset.confirm !== asset.id) resetDeleteButton(el);
        });
      },
      onClick: (_event, el, pswp) => onDelete(el, pswp.currSlide.data.asset),
    });
    ui.registerElement({
      name: 'gw-caption',
      order: 9,
      isButton: false,
      appendTo: 'root',
      onInit: (el, pswp) => {
        el.className = 'gw-caption';
        const text = document.createElement('div');
        el.append(text, $('viewer-note'));
        pswp.on('change', () => {
          text.textContent = captionText(pswp.currSlide.data.asset);
        });
      },
    });
  });
  // The note element lives inside the viewer while it is open; park it again afterwards.
  lightbox.on('destroy', () => {
    const note = $('viewer-note');
    note.textContent = '';
    $('gallery').append(note);
  });
  lightbox.init();
}

function openViewer(index) {
  lightbox.options.dataSource = assets.map(slideData);
  lightbox.loadAndOpen(index);
}

// --- Loading ---

/**
 * @param {(path: string, options?: RequestInit) => Promise<Response>} api fetch wrapper from app.js
 */
async function refresh(api, { force = false } = {}) {
  if (loading) return loading;
  if (!force && Date.now() - loadedAt < REFRESH_AFTER_MS) return undefined;
  $('gallery-status').textContent = '読み込み中…';
  loading = (async () => {
    try {
      const res = await api('/api/assets');
      if (res.status === 401) {
        $('gallery-status').textContent = '';
        onUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const previous = new Map(assets.map((a) => [a.id, a]));
      const { assets: list } = await res.json();
      // Keep aspect ratios learned from loaded thumbnails across refreshes.
      for (const asset of list) asset.aspect = previous.get(asset.id)?.aspect;
      loadedAt = Date.now();
      renderGrid(list);
      bulk?.refresh();
      $('gallery-status').textContent = '';
    } catch (err) {
      if (err?.message !== 'closed') {
        $('gallery-status').textContent = '読み込めませんでした。「更新」を押してください';
      }
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Wire the gallery tab; call once after login when the server reports `gallery: true`.
 * @param {(path: string, options?: RequestInit) => Promise<Response>} api
 * @param {{ onUnauthorized: () => void }} hooks session expired → back to the login screen
 */
export function initGallery(api, hooks) {
  onUnauthorized = hooks.onUnauthorized;
  apiFetch = api;
  if (!lightbox) setupLightbox();
  bulk ??= initBulk({ api, getAssets: () => assets, onUnauthorized: () => onUnauthorized() });
  $('gallery-refresh').onclick = () => refresh(api, { force: true });
  $('gallery-bulk').onclick = () => bulk.toggle();
  return {
    show: () => refresh(api),
    /** @param {{ role: string, canDelete: boolean }} next from /api/session or after login */
    setPermissions: (next) => {
      // A new login means a new device id: `mine` in the cached list belongs to the old one.
      if (next.role !== permissions.role || next.sessionId !== permissions.sessionId) loadedAt = 0;
      permissions = next;
    },
  };
}
