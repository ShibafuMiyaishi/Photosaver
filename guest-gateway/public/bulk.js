// guest-gateway/public/bulk.js
// 「まとめて保存」: スマホは端末の写真アプリへ、PC は ZIP。
// - iPhone / iPad: 原寸を最大 30 件・約 300 MB ずつ 1 件ずつ取得し、共有シートの「…を保存」で写真アプリへ。
//   共有シートには 1 回のタップで 1 回しか出せないので、まとまりごとに 1 タップしてもらう。
//   共有シートに渡せないもの(大きな動画など)は、1 件ずつのダウンロード(「ファイル」アプリ)に回す。
// - Android: 1 件ずつ取得して端末にダウンロードする(「ダウンロード」に保存され、ギャラリーや
//   Google フォトに表示される)。共有シートには写真アプリへ保存する項目が無いため。
// - PC: 窓口が Immich の ZIP を中継する(約 2 GB ごとに分割)。
// スマホでは保存済みをこの端末(ブラウザ)に記録し、次回は続きから。自分が送ったものは既定で除外する。

// One share sheet: Safari keeps every file of it in memory until the sheet is done, so a batch
// stays small and a file that would push it over the budget waits for the next batch.
const SHARE_BATCH_FILES = 30;
const SHARE_BATCH_BYTES = 300 * 1024 ** 2;
const SHARE_BULK_MAX_FILE_BYTES = 200 * 1024 ** 2;
// Single save from the viewer holds one file only.
export const SHARE_MAX_FILE_BYTES = 500 * 1024 ** 2;
// Android bulk holds one file at a time as a Blob; larger ones are offered one by one instead.
const DOWNLOAD_MAX_FILE_BYTES = 500 * 1024 ** 2;
// Retries per original: busy (429) waits longer and more often than errors.
const BUSY_ATTEMPTS = 20;
const ERROR_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 30_000;
// This many items in a row that could not be fetched stop the run (gateway or Immich trouble).
const STOP_AFTER_FAILURES = 3;
// Blob URLs handed to the Android download manager are kept this long before release.
const BLOB_URL_TTL_MS = 60_000;
const SAVED_KEY = 'gw-saved-v1';
// Types for the share sheet when the relay could not label a file (it sends octet-stream then).
const TYPE_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  heif: 'image/heif',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',
};

const $ = (id) => document.getElementById(id);

export function canShareFiles() {
  try {
    return (
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] })
    );
  } catch {
    return false;
  }
}

/**
 * How this device saves: 'share' (iPhone/iPad → Photos via the share sheet), 'download'
 * (Android → Downloads, shown in the gallery), 'zip' (PCs), 'unsupported' (in-app browsers that
 * can do neither: iOS without file sharing, Android WebViews that ignore downloads).
 */
export function saveMode() {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support tells them apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return canShareFiles() ? 'share' : 'unsupported';
  if (/Android/i.test(ua)) {
    return /; wv\)|FBAN|FBAV|Instagram|Line\//i.test(ua) ? 'unsupported' : 'download';
  }
  return 'zip';
}

// --- What has been saved on this device ---

let savedCache = null;

function loadSaved() {
  if (savedCache) return savedCache;
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
    savedCache = new Set(Array.isArray(list) ? list : []);
  } catch {
    savedCache = new Set();
  }
  return savedCache;
}

/** Remember saved assets so 「まとめて保存」 continues where it left off (best effort). */
export function markSaved(ids) {
  const saved = loadSaved();
  for (const id of ids) saved.add(id);
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));
  } catch {
    // Private mode / full storage: kept for this visit only.
  }
}

function clearSaved() {
  savedCache = new Set();
  try {
    localStorage.removeItem(SAVED_KEY);
  } catch {
    // Nothing stored.
  }
}

// --- Helpers ---

export class BulkError extends Error {}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BulkError('stopped'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BulkError('stopped'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with jitter, so many guests do not retry in lockstep. */
function backoff(attempt, atLeastMs = 0) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.max(atLeastMs, Math.round(base * (0.5 + Math.random())));
}

export function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function originalUrl(asset) {
  return `/media/${encodeURIComponent(asset.id)}/original`;
}

/**
 * Fetch one original. Busy (429), server and network errors are retried with backoff.
 * @returns {Promise<{ blob?: Blob, missing?: boolean, tooLarge?: boolean, size?: number }>}
 *   tooLarge: over `maxBytes` (decided from Content-Length before the body is read when possible)
 */
export async function fetchOriginal(asset, { signal, maxBytes = Infinity } = {}) {
  let busy = 0;
  let errors = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(originalUrl(asset), { credentials: 'same-origin', signal });
    } catch {
      if (signal?.aborted) throw new BulkError('stopped');
      errors += 1;
      if (errors >= ERROR_ATTEMPTS) throw new BulkError('failed');
      await sleep(backoff(errors), signal);
      continue;
    }
    if (res.status === 401) throw new BulkError('unauthorized');
    // Deleted meanwhile: nothing to save.
    if (res.status === 404) return { missing: true };
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 429 && busy < BUSY_ATTEMPTS) {
        busy += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(
          backoff(Math.min(busy, 4), Number.isFinite(retryAfter) ? retryAfter * 1000 : 0),
          signal,
        );
        continue;
      }
      errors += 1;
      if (res.status >= 500 && errors < ERROR_ATTEMPTS) {
        await sleep(backoff(errors), signal);
        continue;
      }
      throw new BulkError('failed');
    }
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { tooLarge: true, size: length };
    }
    try {
      const blob = await res.blob();
      if (blob.size > maxBytes) return { tooLarge: true, size: blob.size };
      return { blob };
    } catch {
      if (signal?.aborted) throw new BulkError('stopped');
      errors += 1;
      if (errors >= ERROR_ATTEMPTS) throw new BulkError('failed');
      await sleep(backoff(errors), signal);
    }
  }
}

/** A File for the share sheet or a download, with a usable name and media type. */
export function fileFor(asset, blob) {
  const name = asset.filename || (asset.type === 'video' ? 'video.mov' : 'photo.jpg');
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const labelled = blob.type && blob.type !== 'application/octet-stream';
  const type = labelled ? blob.type : (TYPE_BY_EXTENSION[extension] ?? blob.type);
  return new File([blob], name, { type });
}

/** Only photos and videos the browser accepts can go to Photos through the share sheet. */
export function canShareToPhotos(file) {
  if (!/^(image|video)\//.test(file.type)) return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Hand a file to the browser's download manager (Android: Downloads → gallery). */
function downloadBlob(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
}

/** Plain download by navigation (no memory use); iOS puts it in the Files app. */
export function downloadDirectly(asset) {
  const link = document.createElement('a');
  link.href = `${originalUrl(asset)}?download=1`;
  link.download = asset.filename ?? '';
  document.body.append(link);
  link.click();
  link.remove();
}

// --- Panel ---

const LEAD = {
  share:
    '写真アプリにまとめて保存します。最大 30 件ずつ準備するので、準備ができたらボタンを押し、' +
    '表示されたメニューで「〇項目を保存」(写真だけなら「〇枚の画像を保存」)を選んでください。' +
    'Wi-Fi でのご利用がおすすめです。',
  download:
    'この端末に 1 件ずつダウンロードします。「ダウンロード」に保存され、ギャラリーや ' +
    'Google フォトの「Download」フォルダに表示されます。「複数のファイルをダウンロード」の許可を' +
    '求められたら「許可」を選んでください。Wi-Fi でのご利用がおすすめです。',
  zip: 'ZIP ファイルでまとめてダウンロードします(約 2 GB ごとに分けます)。',
  unsupported:
    'この画面(LINE などのアプリの中のブラウザ)では、まとめて保存できません。' +
    'メニューから Safari(iPhone)または Chrome(Android)で開き直してください。',
};

const IDLE_LABEL = { share: '準備する', download: 'ダウンロードを始める' };

const MANUAL_NOTE = {
  share:
    '次のものは 1 件ずつ保存してください。「ファイル」アプリに保存されるので、「ファイル」アプリで開いて' +
    '共有ボタンから「ビデオを保存」(写真は「画像を保存」)を選ぶと写真アプリに入ります。',
  download: '次の大きな動画は 1 件ずつ保存してください(「ダウンロード」に保存されます)。',
};

/**
 * @param {{
 *   api: (path: string, options?: RequestInit) => Promise<Response>,
 *   getAssets: () => object[],
 *   onUnauthorized: () => void,
 * }} deps
 */
export function initBulk({ api, getAssets, onUnauthorized }) {
  const mode = saveMode();
  let controller = null;
  let wakeLock = null;
  // Share mode: the prepared batch waiting for the guest's tap.
  let batch = [];
  let sharing = false;
  let queue = [];
  // Items to save one by one (too large for the batch, or refused by the share sheet).
  let manual = [];
  let failed = 0;
  let failedInRow = 0;
  let saved = 0;

  const panel = $('bulk');
  const startButton = $('bulk-start');
  const stopButton = $('bulk-stop');
  const zipOther = $('bulk-zip-other');
  const status = (text) => {
    $('bulk-status').textContent = text;
  };
  // Outside the live region: a counter that changes every file must not be read out each time.
  const progress = (text) => {
    $('bulk-progress').textContent = text;
  };

  function targets() {
    const done = loadSaved();
    const excludeMine = $('bulk-exclude-mine').checked;
    return getAssets().filter((a) => !done.has(a.id) && !(excludeMine && a.mine));
  }

  function renderCount() {
    const list = targets();
    const videos = list.filter((a) => a.type === 'video').length;
    $('bulk-count').textContent =
      list.length === 0
        ? 'まだ保存していない写真・動画はありません。'
        : `まだ保存していないもの: ${list.length} 件(写真 ${list.length - videos}・動画 ${videos})`;
  }

  async function holdScreen() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch {
      wakeLock = null;
    }
  }

  function releaseScreen() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  function setIdle() {
    // Whatever is still downloading belongs to the run that just ended.
    controller?.abort();
    controller = null;
    batch = [];
    sharing = false;
    releaseScreen();
    progress('');
    stopButton.hidden = true;
    startButton.disabled = false;
    startButton.textContent = IDLE_LABEL[mode] ?? '';
    $('bulk-exclude-mine').disabled = false;
    renderCount();
  }

  function finish() {
    const parts = saved > 0 || manual.length === 0 ? [`${saved} 件を保存しました。`] : [];
    if (failed > 0) {
      parts.push(
        `${failed} 件は取得できませんでした(もう一度「${IDLE_LABEL[mode]}」で再挑戦できます)。`,
      );
    }
    if (manual.length > 0) parts.push('下の一覧のものは 1 件ずつ保存してください。');
    if (mode === 'download' && saved > 0) {
      parts.push(
        'ダウンロードされていない場合は、「保存済みの記録を消す」を押してからやり直してください。',
      );
    }
    setIdle();
    status(parts.join(''));
  }

  function handleError(err) {
    const reason = err instanceof BulkError ? err.message : '';
    setIdle();
    if (reason === 'unauthorized') {
      status('');
      onUnauthorized();
    } else if (reason === 'stopped') {
      status(`中断しました(${saved} 件を保存済み)。続きは「${IDLE_LABEL[mode]}」から。`);
    } else if (reason === 'unreachable') {
      status(
        `混み合っているか、つながりません(${saved} 件を保存済み)。しばらくしてから「${IDLE_LABEL[mode]}」で続きから。`,
      );
    } else {
      status('うまくいきませんでした。もう一度お試しください。');
    }
  }

  function renderManual() {
    const list = $('bulk-large');
    list.textContent = '';
    list.hidden = manual.length === 0;
    if (manual.length === 0) return;
    const note = document.createElement('li');
    note.className = 'muted';
    note.textContent = MANUAL_NOTE[mode] ?? '';
    list.append(note);
    for (const asset of manual) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'small';
      button.textContent = '保存';
      button.addEventListener('click', () => {
        downloadDirectly(asset);
        markSaved([asset.id]);
        manual = manual.filter((a) => a !== asset);
        renderManual();
        renderCount();
      });
      item.append(`${asset.filename ?? (asset.type === 'video' ? '動画' : '写真')} `, button);
      list.append(item);
    }
  }

  /** Fetch for a run; repeated failures stop the run instead of failing every item slowly. */
  async function fetchForRun(asset, maxBytes) {
    // The run was stopped between two files.
    if (!controller) throw new BulkError('stopped');
    try {
      const result = await fetchOriginal(asset, { signal: controller.signal, maxBytes });
      failedInRow = 0;
      return result;
    } catch (err) {
      if (!(err instanceof BulkError) || err.message !== 'failed') throw err;
      failed += 1;
      failedInRow += 1;
      if (failedInRow >= STOP_AFTER_FAILURES) throw new BulkError('unreachable');
      return {};
    }
  }

  // iPhone / iPad: fill a batch one file at a time, then wait for the guest's tap.
  async function prepareBatch() {
    startButton.disabled = true;
    startButton.textContent = '準備中…';
    status('準備しています…');
    while (batch.length === 0 && queue.length > 0) {
      let bytes = 0;
      const goal = Math.min(SHARE_BATCH_FILES, queue.length);
      while (queue.length > 0 && batch.length < SHARE_BATCH_FILES && bytes < SHARE_BATCH_BYTES) {
        const asset = queue[0];
        const limit =
          batch.length === 0
            ? SHARE_BULK_MAX_FILE_BYTES
            : Math.min(SHARE_BULK_MAX_FILE_BYTES, SHARE_BATCH_BYTES - bytes);
        const result = await fetchForRun(asset, limit);
        // Fits a batch, just not this one: it starts the next batch.
        if (result.tooLarge && batch.length > 0 && result.size <= SHARE_BULK_MAX_FILE_BYTES) break;
        queue.shift();
        if (result.tooLarge) {
          manual.push(asset);
        } else if (result.blob) {
          const file = fileFor(asset, result.blob);
          if (canShareToPhotos(file)) {
            batch.push({ asset, file });
            bytes += file.size;
          } else {
            manual.push(asset);
          }
        }
        progress(`準備中… ${Math.min(batch.length, goal)} / ${goal} 件`);
      }
      renderManual();
    }
    progress('');
    if (batch.length === 0) {
      finish();
      return;
    }
    startButton.disabled = false;
    startButton.textContent = `写真アプリに保存(${batch.length} 件)`;
    status(
      queue.length > 0
        ? `準備ができました。ボタンを押して保存してください(残り ${queue.length} 件)。`
        : '準備ができました。ボタンを押して保存してください。',
    );
  }

  async function shareBatch() {
    // A second tap while the sheet is open would make share() fail and confuse the status.
    sharing = true;
    startButton.disabled = true;
    try {
      await navigator.share({ files: batch.map((b) => b.file) });
    } catch (err) {
      sharing = false;
      startButton.disabled = false;
      if (err?.name === 'AbortError') {
        status('キャンセルしました。もう一度ボタンを押すと保存できます。');
        return;
      }
      if (err?.name === 'NotAllowedError') {
        status('保存メニューを開けませんでした。もう一度ボタンを押してください。');
        return;
      }
      // The sheet refused these files: offer them one by one and go on with the rest.
      manual.push(...batch.map((b) => b.asset));
      batch = [];
      renderManual();
      prepareBatch().catch(handleError);
      return;
    }
    sharing = false;
    // The guest picked some action in the sheet (normally 「…を保存」); it cannot be told apart.
    markSaved(batch.map((b) => b.asset.id));
    saved += batch.length;
    batch = [];
    if (queue.length === 0) {
      finish();
      return;
    }
    prepareBatch().catch(handleError);
  }

  // Android: one file at a time into the download manager.
  async function downloadAll() {
    startButton.disabled = true;
    startButton.textContent = 'ダウンロード中…';
    status('ダウンロードしています…');
    const total = queue.length;
    let done = 0;
    while (queue.length > 0) {
      const asset = queue.shift();
      progress(`ダウンロード中… ${done + 1} / ${total} 件`);
      const result = await fetchForRun(asset, DOWNLOAD_MAX_FILE_BYTES);
      if (result.tooLarge) {
        manual.push(asset);
        renderManual();
      } else if (result.blob) {
        downloadBlob(fileFor(asset, result.blob));
        markSaved([asset.id]);
        saved += 1;
      }
      done += 1;
    }
    finish();
  }

  async function createZip(button) {
    button.disabled = true;
    status('ZIP を準備しています…');
    const list = $('bulk-zip');
    list.textContent = '';
    list.hidden = true;
    try {
      const res = await api('/api/download', { method: 'POST' });
      if (res.status === 401) {
        status('');
        onUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const plan = await res.json();
      if (plan.parts.length === 0) {
        status('まだ写真がありません。');
        return;
      }
      plan.parts.forEach((part, i) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `/download/${encodeURIComponent(plan.id)}/${i + 1}`;
        link.className = 'zip-link';
        link.textContent =
          plan.parts.length === 1 ? 'ZIP をダウンロード' : `ZIP ${i + 1} / ${plan.parts.length}`;
        link.addEventListener('click', () => item.classList.add('started'));
        item.append(link, ` ${formatSize(part.size)}・${part.count} 件`);
        list.append(item);
      });
      list.hidden = false;
      status(
        `全 ${formatSize(plan.totalSize)}。` +
          (plan.parts.length > 1 ? '1 つずつダウンロードしてください(同時に 2 つまで)。' : ''),
      );
    } catch {
      status('ZIP を準備できませんでした。もう一度お試しください。');
    } finally {
      button.disabled = false;
    }
  }

  function start() {
    if (mode === 'zip') {
      createZip(startButton);
      return;
    }
    // Share mode with a prepared batch: this tap opens the share sheet (still a user gesture).
    if (mode === 'share' && batch.length > 0) {
      if (!sharing) shareBatch();
      return;
    }
    if (controller) return;
    queue = targets();
    manual = [];
    failed = 0;
    failedInRow = 0;
    saved = 0;
    renderManual();
    if (queue.length === 0) {
      status('まだ保存していない写真・動画はありません。');
      return;
    }
    controller = new AbortController();
    stopButton.hidden = false;
    $('bulk-exclude-mine').disabled = true;
    holdScreen();
    const run = mode === 'share' ? prepareBatch() : downloadAll();
    run.catch(handleError);
  }

  function setup() {
    $('bulk-lead').textContent = LEAD[mode];
    $('bulk-phone').hidden = mode !== 'share' && mode !== 'download';
    startButton.hidden = mode === 'unsupported';
    $('bulk-zip').hidden = true;
    // On a phone ZIP is still offered (e.g. to keep everything in the Files app).
    zipOther.hidden = mode === 'zip';
    if (mode === 'zip') startButton.textContent = 'ZIP を作成';
    else setIdle();
  }

  startButton.addEventListener('click', start);
  stopButton.addEventListener('click', () => {
    if (!controller) return;
    handleError(new BulkError('stopped'));
  });
  $('bulk-exclude-mine').addEventListener('change', renderCount);
  $('bulk-reset').addEventListener('click', () => {
    clearSaved();
    renderCount();
    status('保存済みの記録を消しました。');
  });
  zipOther.addEventListener('click', () => createZip(zipOther));
  // Coming back to the page re-acquires the screen lock that the OS dropped.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && controller) holdScreen();
  });
  setup();

  return {
    mode,
    toggle() {
      panel.hidden = !panel.hidden;
      $('gallery-bulk').setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden && mode !== 'zip') renderCount();
    },
    /** The list changed (refresh, delete): update the count unless a run is going. */
    refresh() {
      if (!panel.hidden && !controller && mode !== 'zip') renderCount();
    },
  };
}
