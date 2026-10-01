// guest-gateway/public/gallery.js
// 「みんなの写真」: アルバム全体のサムネイル一覧 → PhotoSwipe で拡大・スワイプ・動画再生 → 保存。
// 保存は写真なら原寸を取得してから共有シート(写真アプリへ保存)、動画や非対応端末は直接ダウンロード。
// 原寸の先読みはしない(ゲスト全員が見るだけで数 GB になるため)。1 回目のタップで準備、2 回目で保存。

import PhotoSwipeLightbox from '/vendor/photoswipe/photoswipe-lightbox.esm.min.js';

// Retries for thumbnails that are not ready yet (404 while Immich generates them) or busy (429).
const THUMB_RETRY_MS = [2000, 5000, 15000, 30000, 60000];
const REFRESH_AFTER_MS = 30_000;

const $ = (id) => document.getElementById(id);

let assets = [];
let lightbox = null;
let loadedAt = 0;
let loading = null;
// Prepared originals for the share sheet: assetId → File (only the photo being saved).
const prepared = new Map();

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

function canShareFiles() {
  try {
    return (
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] })
    );
  } catch {
    return false;
  }
}

// --- Thumbnails ---

function loadThumb(img, asset, attempt = 0) {
  img.onerror = () => {
    if (attempt >= THUMB_RETRY_MS.length) return;
    setTimeout(() => loadThumb(img, asset, attempt + 1), THUMB_RETRY_MS[attempt]);
  };
  // A new URL per attempt: the browser does not refetch an identical failed src.
  img.src =
    attempt === 0 ? mediaUrl(asset, 'thumbnail') : `${mediaUrl(asset, 'thumbnail')}?r=${attempt}`;
}

function renderGrid() {
  const grid = $('grid');
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
    img.loading = 'lazy';
    img.decoding = 'async';
    loadThumb(img, asset);
    tile.append(img);
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
  $('gallery-count').textContent = `${assets.length} 件`;
  $('gallery-empty').hidden = assets.length > 0;
}

// --- Viewer (PhotoSwipe) ---

function slideData(asset) {
  // Preview size is unknown until loaded; the original's aspect ratio is close enough and is
  // corrected on load (see loadComplete below).
  const width = asset.width || 1200;
  const height = asset.height || 1200;
  if (asset.type === 'video') return { type: 'video', asset, width, height };
  return {
    src: mediaUrl(asset, 'preview'),
    msrc: mediaUrl(asset, 'thumbnail'),
    asset,
    width,
    height,
  };
}

function captionText(asset) {
  return [asset.by ? `${asset.by} さん` : '', formatDate(asset.takenAt)]
    .filter(Boolean)
    .join(' ・ ');
}

function saveLabel(asset) {
  if (asset.type === 'video' || !canShareFiles()) return '保存';
  return prepared.has(asset.id) ? '写真に保存' : '保存';
}

function downloadDirectly(asset) {
  const link = document.createElement('a');
  link.href = `${mediaUrl(asset, 'original')}?download=1`;
  link.download = asset.filename ?? '';
  document.body.append(link);
  link.click();
  link.remove();
}

async function onSave(button, asset) {
  if (asset.type === 'video' || !canShareFiles()) {
    downloadDirectly(asset);
    $('viewer-note').textContent =
      asset.type === 'video' ? '動画はダウンロードされます(iPhone は「ファイル」アプリ)' : '';
    return;
  }
  const file = prepared.get(asset.id);
  if (file) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      // AbortError = the guest closed the share sheet; anything else → plain download.
      if (err?.name !== 'AbortError') downloadDirectly(asset);
    }
    return;
  }
  // First tap: fetch the original now (the share sheet needs the file before the next tap).
  button.disabled = true;
  button.textContent = '準備中…';
  try {
    const res = await fetch(mediaUrl(asset, 'original'), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    prepared.clear();
    prepared.set(asset.id, new File([blob], asset.filename || 'photo.jpg', { type: blob.type }));
    $('viewer-note').textContent = 'もう一度タップすると写真アプリに保存できます';
  } catch {
    $('viewer-note').textContent = '取得できませんでした。もう一度お試しください';
  } finally {
    button.disabled = false;
    button.textContent = saveLabel(asset);
  }
}

function createVideoContent(content) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pswp__content gw-video';
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.poster = mediaUrl(content.data.asset, 'preview');
  video.src = mediaUrl(content.data.asset, 'video');
  wrapper.append(video);
  return wrapper;
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
  // Pause videos that are swiped away; drop their source when the slide is destroyed so the
  // download stops (the gateway also closes idle streams).
  lightbox.on('contentDeactivate', ({ content }) => {
    content.element?.querySelector('video')?.pause();
  });
  lightbox.on('contentDestroy', ({ content }) => {
    const video = content.element?.querySelector('video');
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
  });

  // Correct the aspect ratio once the real preview is known (e.g. rotated phone photos).
  lightbox.on('loadComplete', ({ content, slide }) => {
    const img = content.element;
    if (!img?.naturalWidth || !slide) return;
    const natural = img.naturalWidth / img.naturalHeight;
    const declared = content.data.width / content.data.height;
    if (Math.abs(natural - declared) < 0.02) return;
    const longSide = Math.max(content.data.width, content.data.height);
    const item = lightbox.options.dataSource[slide.index];
    item.width = natural >= 1 ? longSide : Math.round(longSide * natural);
    item.height = natural >= 1 ? Math.round(longSide / natural) : longSide;
    lightbox.pswp.refreshSlideContent(slide.index);
  });

  lightbox.on('uiRegister', () => {
    const { ui } = lightbox.pswp;
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
          el.textContent = saveLabel(pswp.currSlide.data.asset);
          $('viewer-note').textContent = '';
        });
      },
      onClick: (_event, el, pswp) => onSave(el, pswp.currSlide.data.asset),
    });
    ui.registerElement({
      name: 'gw-caption',
      order: 9,
      isButton: false,
      appendTo: 'root',
      onInit: (el, pswp) => {
        el.className = 'gw-caption';
        const text = document.createElement('div');
        const note = $('viewer-note');
        el.append(text, note);
        pswp.on('change', () => {
          text.textContent = captionText(pswp.currSlide.data.asset);
        });
      },
    });
  });
  // The note element lives inside the viewer while it is open; park it again on close.
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
      if (res.status === 401) return;
      if (!res.ok) throw new Error(String(res.status));
      ({ assets } = await res.json());
      loadedAt = Date.now();
      renderGrid();
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

/** Wire the gallery tab; call once after login when the server reports `gallery: true`. */
export function initGallery(api) {
  if (!lightbox) setupLightbox();
  $('gallery-refresh').onclick = () => refresh(api, { force: true });
  return { show: () => refresh(api) };
}
