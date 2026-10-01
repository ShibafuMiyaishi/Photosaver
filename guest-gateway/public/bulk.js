// guest-gateway/public/bulk.js
// 「まとめて保存」: スマホは端末の写真アプリへ、PC は ZIP。
// - iPhone / iPad: 原寸を数十件ずつ取得し、共有シートの「N 項目を保存」で写真アプリへ入れる。
//   共有シートには 1 回のタップで 1 回しか出せないので、まとまりごとに 1 タップしてもらう。
//   共有シートに渡せない大きな動画だけ、個別にダウンロード(「ファイル」アプリ)にする。
// - Android: 1 件ずつ取得して端末にダウンロードする(「ダウンロード」に保存され、ギャラリーや
//   Google フォトに表示される)。共有シートには写真アプリへ保存する項目が無いため。
// - PC: 窓口が Immich の ZIP を中継する(約 2 GB ごとに分割)。
// 保存済みはこの端末(ブラウザ)に記録し、次回は続きから。自分が送ったものは既定で除外する。

// One share sheet: Safari keeps the files in memory until it is done.
const SHARE_BATCH_FILES = 30;
const SHARE_BATCH_BYTES = 300 * 1024 ** 2;
// A file larger than this is not handed to the share sheet; it is downloaded instead.
export const SHARE_MAX_FILE_BYTES = 500 * 1024 ** 2;
// Originals fetched at once (the gateway allows 4 per device for originals and videos).
const FETCH_CONCURRENCY = 2;
// Attempts per original on 429 / 5xx / network errors.
const FETCH_ATTEMPTS = 6;
// Blob URLs handed to the Android download manager are kept this long before release.
const BLOB_URL_TTL_MS = 60_000;
const SAVED_KEY = 'gw-saved-v1';

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
 * (Android → Downloads, shown in the gallery), 'zip' (PCs), 'unsupported' (iOS without file
 * sharing, e.g. some in-app browsers).
 */
export function saveMode() {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support tells them apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return canShareFiles() ? 'share' : 'unsupported';
  if (/Android/i.test(ua)) return 'download';
  return 'zip';
}

// --- What has been saved on this device ---

function loadSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

/** Remember saved assets so 「まとめて保存」 continues where it left off (best effort). */
export function markSaved(ids) {
  const saved = loadSaved();
  for (const id of ids) saved.add(id);
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));
  } catch {
    // Private mode / full storage: the next run simply offers these again.
  }
}

function clearSaved() {
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
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new BulkError('stopped'));
      },
      { once: true },
    );
  });
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
 * Fetch one original, retrying busy (429), server and network errors.
 * @returns {Promise<{ blob?: Blob, missing?: boolean, tooLarge?: boolean }>}
 */
export async function fetchOriginal(asset, { signal, maxBytes = Infinity } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(originalUrl(asset), { credentials: 'same-origin', signal });
    } catch {
      if (signal?.aborted) throw new BulkError('stopped');
      if (attempt >= FETCH_ATTEMPTS) throw new BulkError('failed');
      await sleep(2000 * attempt, signal);
      continue;
    }
    if (res.status === 401) throw new BulkError('unauthorized');
    // Deleted meanwhile: nothing to save.
    if (res.status === 404) return { missing: true };
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if ((res.status === 429 || res.status >= 500) && attempt < FETCH_ATTEMPTS) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000,
          signal,
        );
        continue;
      }
      throw new BulkError('failed');
    }
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { tooLarge: true };
    }
    try {
      const blob = await res.blob();
      if (blob.size > maxBytes) return { tooLarge: true };
      return { blob };
    } catch {
      if (signal?.aborted) throw new BulkError('stopped');
      if (attempt >= FETCH_ATTEMPTS) throw new BulkError('failed');
    }
  }
}

export function fileFor(asset, blob) {
  const fallback = asset.type === 'video' ? 'video.mov' : 'photo.jpg';
  return new File([blob], asset.filename || fallback, { type: blob.type });
}

/** Hand a file to the browser's download manager (Android: Downloads → gallery). */
function downloadBlob(asset, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = asset.filename || '';
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
    '写真アプリにまとめて保存します。30 件ずつ準備するので、準備ができたらボタンを押し、' +
    '表示されたメニューで「〇項目を保存」を選んでください。Wi-Fi でのご利用がおすすめです。',
  download:
    'この端末に 1 件ずつダウンロードします。「ダウンロード」に保存され、ギャラリーや ' +
    'Google フォトの「Download」フォルダに表示されます。「複数のファイルをダウンロード」の許可を' +
    '求められたら「許可」を選んでください。Wi-Fi でのご利用がおすすめです。',
  zip: 'ZIP ファイルでまとめてダウンロードします(約 2 GB ごとに分けます)。',
  unsupported:
    'この画面(アプリの中のブラウザなど)では、写真アプリへまとめて保存できません。' +
    '右上のメニューから Safari で開き直してください。',
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
  let queue = [];
  let large = [];
  let failed = 0;
  let saved = 0;

  const panel = $('bulk');
  const startButton = $('bulk-start');
  const stopButton = $('bulk-stop');
  const status = (text) => {
    $('bulk-status').textContent = text;
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
    return list.length;
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
    controller = null;
    batch = [];
    releaseScreen();
    stopButton.hidden = true;
    startButton.disabled = false;
    startButton.textContent = mode === 'download' ? 'ダウンロードを始める' : '準備する';
    $('bulk-exclude-mine').disabled = false;
    renderCount();
  }

  function finish() {
    const parts = [`${saved} 件を保存しました。`];
    if (failed > 0)
      parts.push(`${failed} 件は取得できませんでした(もう一度「準備する」で再挑戦できます)。`);
    if (large.length > 0) parts.push('大きな動画は下のボタンから 1 件ずつ保存してください。');
    status(parts.join(''));
    setIdle();
  }

  function handleError(err) {
    if (err instanceof BulkError && err.message === 'unauthorized') {
      setIdle();
      onUnauthorized();
      return;
    }
    if (err instanceof BulkError && err.message === 'stopped') {
      status(`中断しました(${saved} 件を保存済み)。続きは「準備する」から。`);
      setIdle();
      return;
    }
    status('うまくいきませんでした。もう一度お試しください。');
    setIdle();
  }

  function renderLarge() {
    const list = $('bulk-large');
    list.textContent = '';
    list.hidden = large.length === 0;
    for (const asset of large) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'small';
      button.textContent = '保存';
      button.addEventListener('click', () => {
        downloadDirectly(asset);
        markSaved([asset.id]);
        large = large.filter((a) => a !== asset);
        renderLarge();
      });
      item.append(`${asset.filename ?? '動画'} `, button);
      list.append(item);
    }
    if (large.length > 0) {
      const note = document.createElement('li');
      note.className = 'muted';
      note.textContent =
        '大きな動画は「ファイル」アプリに保存されます。「ファイル」アプリで開いて共有ボタンから「ビデオを保存」を選ぶと写真アプリに入ります。';
      list.prepend(note);
    }
  }

  // iPhone / iPad: fill a batch, then wait for the guest's tap on the share button.
  async function prepareBatch() {
    const { signal } = controller;
    batch = [];
    let bytes = 0;
    startButton.disabled = true;
    const goal = Math.min(SHARE_BATCH_FILES, queue.length);
    status(`準備中… 0 / ${goal} 件`);
    while (queue.length > 0 && batch.length < SHARE_BATCH_FILES && bytes < SHARE_BATCH_BYTES) {
      const next = queue.splice(0, FETCH_CONCURRENCY);
      const results = await Promise.all(
        next.map((asset) =>
          fetchOriginal(asset, { signal, maxBytes: SHARE_MAX_FILE_BYTES }).catch((err) => {
            if (err instanceof BulkError && err.message !== 'failed') throw err;
            failed += 1;
            return {};
          }),
        ),
      );
      results.forEach((result, i) => {
        if (result.tooLarge) large.push(next[i]);
        else if (result.blob) {
          batch.push({ asset: next[i], file: fileFor(next[i], result.blob) });
          bytes += result.blob.size;
        }
      });
      status(`準備中… ${Math.min(batch.length, goal)} / ${goal} 件`);
    }
    renderLarge();
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
    try {
      await navigator.share({ files: batch.map((b) => b.file) });
    } catch (err) {
      // AbortError: the guest closed the sheet; keep the batch for another tap.
      status(
        err?.name === 'AbortError'
          ? 'キャンセルしました。もう一度ボタンを押すと保存できます。'
          : '保存メニューを開けませんでした。もう一度ボタンを押してください。',
      );
      return;
    }
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
    const { signal } = controller;
    const total = queue.length;
    let done = 0;
    while (queue.length > 0) {
      const asset = queue.shift();
      status(`ダウンロード中… ${done + 1} / ${total} 件`);
      let result;
      try {
        result = await fetchOriginal(asset, { signal });
      } catch (err) {
        if (err instanceof BulkError && err.message !== 'failed') throw err;
        failed += 1;
        result = {};
      }
      if (result.blob) {
        downloadBlob(asset, result.blob);
        markSaved([asset.id]);
        saved += 1;
      }
      done += 1;
    }
    finish();
  }

  async function createZip() {
    startButton.disabled = true;
    status('ZIP を準備しています…');
    const list = $('bulk-zip');
    list.textContent = '';
    try {
      const res = await api('/api/download', { method: 'POST' });
      if (res.status === 401) {
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
      startButton.disabled = false;
    }
  }

  function start() {
    if (mode === 'zip') {
      createZip();
      return;
    }
    // Share mode with a prepared batch: this tap opens the share sheet.
    if (mode === 'share' && batch.length > 0) {
      shareBatch();
      return;
    }
    if (controller) return;
    queue = targets();
    large = [];
    failed = 0;
    saved = 0;
    renderLarge();
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
    const phone = mode === 'share' || mode === 'download';
    $('bulk-phone').hidden = !phone;
    startButton.hidden = mode === 'unsupported';
    $('bulk-zip').hidden = true;
    $('bulk-zip-other').hidden = mode === 'zip';
    if (mode === 'zip') startButton.textContent = 'ZIP を作成';
    else setIdle();
  }

  startButton.addEventListener('click', start);
  stopButton.addEventListener('click', () => {
    controller?.abort();
    // A prepared batch waiting for the tap has nothing in flight to notice the abort.
    if (mode === 'share' && batch.length > 0) {
      status(`中断しました(${saved} 件を保存済み)。続きは「準備する」から。`);
      setIdle();
    }
  });
  $('bulk-exclude-mine').addEventListener('change', renderCount);
  $('bulk-reset').addEventListener('click', () => {
    clearSaved();
    renderCount();
    status('保存済みの記録を消しました。');
  });
  // On a phone, ZIP is still available (e.g. to keep everything in the Files app).
  $('bulk-zip-other').addEventListener('click', () => {
    $('bulk-zip-other').hidden = true;
    createZip();
  });
  // Coming back to the page re-acquires the screen lock that the OS dropped.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && controller) holdScreen();
  });
  setup();

  return {
    mode,
    toggle() {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && mode !== 'zip') renderCount();
    },
    /** The list changed (refresh, delete): update the count unless a run is going. */
    refresh() {
      if (!panel.hidden && !controller && mode !== 'zip') renderCount();
    },
  };
}
