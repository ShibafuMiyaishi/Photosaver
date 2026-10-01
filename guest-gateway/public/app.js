// guest-gateway/public/app.js
// ゲスト用画面: ニックネーム + 合言葉でログイン → tus で 1 件ずつアップロード(進捗・所要時間・速度を表示)
// → 送信後はサーバー側の取り込み状態をポーリングし、アルバムに入ったかを表示する。
// 通信の失敗は自動で再開する: 画面に戻ったとき(iOS は画面ロックやアプリ切替で通信が止まる)、
// 電波が戻ったとき(オフラインの間は次の 1 件に進まず待つ)、画面を開いたままなら間隔を空けて。
// 最初の読み込みに失敗したら「読み込めませんでした」と再読み込みボタンを出す。

/* global tus */

import { initGallery } from './gallery.js';
import {
  autoRetryDelay,
  isPermanentFailure,
  isTransientFailure,
  MAX_AUTO_RETRIES,
} from './upload-retry.js';

const CSRF_HEADERS = { 'X-Requested-With': 'guest-gateway' };
const CHUNK_SIZE = 50 * 1024 * 1024;
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10000, 20000, 30000];
const POLL_INTERVAL_MS = 3000;
// Must not exceed MAX_STATUS_IDS in src/app.js.
const POLL_BATCH = 100;
const NICKNAME_KEY = 'gw-nickname';
// A request that hangs on a weak signal must not leave the page on 「読み込み中…」 forever.
const SESSION_TIMEOUT_MS = 20_000;
const SECTIONS = ['loading', 'load-error', 'login', 'uploader'];

const $ = (id) => document.getElementById(id);
const items = [];
let active = null;
let wakeLock = null;
// True when the server imports into Immich (false in the speed-test mode).
let importing = false;
let pollTimer = null;
// Set once the server reports the gallery (import mode).
let galleryEnabled = false;
// Role and delete availability from the server (admin = organiser, may delete anything).
// sessionId changes on every login so the gallery knows its `mine` flags are stale.
const permissions = { role: 'guest', canDelete: false, sessionId: 0 };
let gallery = null;
// Set when the server answered 401: the queue waits (instead of failing item after item)
// until the guest has logged in again.
let needsLogin = false;
let initializing = false;

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatSeconds(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
}

function show(section) {
  for (const id of SECTIONS) $(id).hidden = id !== section;
}

/** The session expired (401): ask for the password again; uploads wait until then. */
function requireLogin() {
  needsLogin = true;
  show('login');
}

// Some in-app browsers / VPN setups report offline while the network works and never fire
// 'online'. Once an upload makes progress while navigator.onLine says false, stop trusting it.
let onLineUnreliable = false;
// Set when an upload failed while offline: the queue then waits for 'online' (or 再試行)
// instead of failing item after item. Starting is never blocked on navigator.onLine alone.
let offlinePause = false;
const OFFLINE_CHECK_MS = 10_000;

let offlineCheckTimer = null;

/** Backstop for a missed 'online' event: while paused, look again every few seconds. */
function scheduleOfflineCheck() {
  clearTimeout(offlineCheckTimer);
  offlineCheckTimer = setTimeout(() => {
    offlineCheckTimer = null;
    if (!offlinePause) return;
    if (isOffline()) scheduleOfflineCheck();
    else requeueFailed('待機中(通信が戻ったので再開)');
  }, OFFLINE_CHECK_MS);
}

/** navigator.onLine is only trustworthy when it says false (no network at all). */
function isOffline() {
  return !onLineUnreliable && navigator.onLine === false;
}

/** Called when an upload got through: the network works whatever navigator.onLine says. */
function noteNetworkWorks() {
  if (navigator.onLine === false) onLineUnreliable = true;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...CSRF_HEADERS, ...(options.headers ?? {}) },
  });
  if (res.status === 410) {
    document.body.textContent = 'このアップロード窓口は受付を終了しました。';
    throw new Error('closed');
  }
  return res;
}

// --- Screen wake lock (best effort; iOS Safari 16.4+) ---

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// --- Queue rendering ---

function renderItem(item) {
  const li = document.createElement('li');
  const name = document.createElement('div');
  name.textContent = item.file.name;
  const bar = document.createElement('progress');
  bar.max = 100;
  bar.value = 0;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const info = document.createElement('div');
  info.className = 'meta';
  const modified = new Date(item.file.lastModified).toLocaleString('ja-JP');
  info.textContent = `${item.file.type || '種類不明'} / ${formatBytes(item.file.size)} / 更新日時 ${modified}`;
  li.append(name, bar, meta, info);
  item.el = { li, bar, meta };
  $('queue').append(li);
}

function updateItem(item, text) {
  item.el.meta.textContent = text;
  item.el.li.querySelector('.retry')?.remove();
  if (item.status === 'error') {
    const btn = document.createElement('button');
    btn.className = 'retry';
    btn.type = 'button';
    btn.textContent = '再試行';
    btn.addEventListener('click', () => retry(item));
    item.el.li.append(btn);
  }
}

function updateSummary() {
  const count = (status) => items.filter((i) => i.status === status).length;
  const failed = count('error');
  const rejected = count('rejected');
  const adding = count('importing');
  const waiting = items.some((i) => i.status === 'queued' || i.status === 'error');
  $('summary').textContent =
    `完了 ${count('done')} / ${items.length} 件` +
    (adding ? `(アルバムに追加中 ${adding} 件)` : '') +
    (failed ? `(失敗 ${failed} 件 — 再試行できます)` : '') +
    (rejected ? `(受付不可 ${rejected} 件)` : '') +
    (waiting && offlinePause && isOffline()
      ? ' — 通信が切れています。電波が戻ると自動で再開します'
      : '');
}

function showTab(name) {
  $('upload-pane').hidden = name !== 'upload';
  $('gallery').hidden = name !== 'gallery';
  $('tab-upload').setAttribute('aria-pressed', String(name === 'upload'));
  $('tab-gallery').setAttribute('aria-pressed', String(name === 'gallery'));
  if (name === 'gallery') {
    gallery ??= initGallery(api, { onUnauthorized: requireLogin });
    gallery.setPermissions({ ...permissions });
    gallery.show();
  }
}

function enterApp() {
  show('uploader');
  $('tabs').hidden = !galleryEnabled;
  showTab('upload');
}

function setGreeting(nickname) {
  const admin = permissions.role === 'admin' ? '(管理者モード: すべての写真を削除できます)' : '';
  $('greeting').textContent = nickname ? `${nickname} さん、ようこそ${admin}` : '';
}

function rememberNickname(nickname) {
  try {
    localStorage.setItem(NICKNAME_KEY, nickname);
  } catch {
    // Private mode etc.: the field is just not prefilled next time.
  }
}

function recallNickname() {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

// --- Import status (server → Immich) ---

const IMPORT_RESULT = {
  created: { status: 'done', text: '完了 — アルバムに追加しました' },
  duplicate: { status: 'done', text: '完了 — 同じ写真が既にアルバムにあります' },
  trashed: {
    status: 'rejected',
    text: '以前に削除された写真のため追加されませんでした(戻したい場合は幹事に連絡してください)',
  },
  failed: {
    status: 'rejected',
    text: 'アルバムへの追加に失敗しました(お手数ですが幹事に連絡してください)',
  },
};

/** tus upload id = last path segment of the upload URL. */
function uploadIdOf(item) {
  try {
    return new URL(item.upload.url, document.baseURI).pathname.split('/').pop();
  } catch {
    return null;
  }
}

// A new login gets a new device id, and the server only reports the caller's own uploads, so
// items sent under the previous session can no longer be polled. The server still imports them.
function settleOrphanedImports() {
  for (const item of items) {
    if (item.status !== 'importing') continue;
    item.status = 'done';
    updateItem(item, '送信完了 — アルバムへの追加はサーバー側で続いています');
  }
  updateSummary();
}

function schedulePoll() {
  if (pollTimer || !items.some((i) => i.status === 'importing' && i.uploadId)) return;
  pollTimer = setTimeout(pollImports, POLL_INTERVAL_MS);
}

async function pollImports() {
  pollTimer = null;
  const waiting = items
    .filter((i) => i.status === 'importing' && i.uploadId)
    .slice(0, POLL_BATCH)
    .map((i) => i.uploadId);
  if (waiting.length === 0) return;
  try {
    const res = await api(`/api/uploads?ids=${waiting.map(encodeURIComponent).join(',')}`);
    if (res.status === 401) {
      requireLogin();
      return;
    }
    if (res.ok) {
      const { uploads } = await res.json();
      const byId = new Map(uploads.map((u) => [u.id, u.status]));
      for (const item of items) {
        const result = item.status === 'importing' && IMPORT_RESULT[byId.get(item.uploadId)];
        if (!result) continue;
        item.status = result.status;
        updateItem(item, result.text);
      }
      updateSummary();
    }
  } catch {
    // Network hiccup or closed: try again on the next tick.
  }
  schedulePoll();
}

// --- Upload ---

function rejectedText(status) {
  if (status === 507) return '受付不可(507)— サーバーの保存容量が不足しています';
  if (status === 413) return '受付不可(413)— ファイルが大きすぎます';
  if (status === 415) return '受付不可(415)— 対応していない形式のファイルです';
  return `受付不可(${status})— このファイルはサーバーに受け付けられませんでした`;
}

function failedText(item) {
  const head = `失敗(${item.lastStatus ?? '通信エラー'})— `;
  if (item.lastStatus === 401) return `${head}もう一度ログインすると再開します`;
  if (isOffline()) return `${head}電波が戻ると自動で再開します`;
  if (item.retryTimer)
    return `${head}約${Math.round(item.retryDelay / 1000)}秒後に自動で再試行します`;
  return `${head}「再試行」を押すとやり直します(画面を開き直したときも再開します)`;
}

function speedText(item, bytesSent) {
  const elapsed = performance.now() - item.startedAt;
  const sent = bytesSent - item.startOffset;
  const mbps = elapsed > 0 ? (sent * 8) / elapsed / 1000 : 0;
  return `${formatSeconds(elapsed)} / ${mbps.toFixed(1)} Mbps`;
}

function createUpload(item) {
  return new tus.Upload(item.file, {
    endpoint: '/files/',
    chunkSize: CHUNK_SIZE,
    retryDelays: RETRY_DELAYS,
    headers: CSRF_HEADERS,
    metadata: {
      filename: item.file.name,
      filetype: item.file.type,
      lastModified: String(item.file.lastModified),
    },
    // Re-selecting the same file after a reload should resume, so avoid volatile fields.
    // lastModified too: iOS can name different photos alike (e.g. image.jpg).
    fingerprint: async (file) => ['gw', file.name, file.size, file.lastModified].join(':'),
    removeFingerprintOnSuccess: true,
    // tus' default gives up at once while navigator.onLine is false, so one Wi-Fi blip failed
    // the whole queue. Same status rules without that check: RETRY_DELAYS ride out about a
    // minute offline; after that the item fails and the queue waits for 'online'.
    onShouldRetry: (err) => isTransientFailure(err.originalResponse?.getStatus?.()),
    // A chunk the server confirmed proves the network works (see noteNetworkWorks).
    onChunkComplete: noteNetworkWorks,
    onProgress(bytesSent, bytesTotal) {
      if (item.startOffset === null) item.startOffset = bytesSent;
      item.el.bar.value = bytesTotal ? (bytesSent / bytesTotal) * 100 : 0;
      updateItem(
        item,
        `送信中 ${formatBytes(bytesSent)} / ${formatBytes(bytesTotal)} — ${speedText(item, bytesSent)}`,
      );
    },
    onSuccess({ lastResponse }) {
      noteNetworkWorks();
      item.el.bar.value = 100;
      if (importing) {
        item.status = 'importing';
        item.uploadId = uploadIdOf(item);
        updateItem(item, `送信完了(${speedText(item, item.file.size)})— アルバムに追加中…`);
        schedulePoll();
      } else {
        item.status = 'done';
        const detected = lastResponse?.getHeader('X-GW-Detected-Type') ?? '?';
        updateItem(item, `完了 — ${speedText(item, item.file.size)} / 判定 ${detected}`);
      }
      finish();
    },
    onError(err) {
      const status = err.originalResponse?.getStatus?.();
      if (status === 410) {
        document.body.textContent = 'このアップロード窓口は受付を終了しました。';
        releaseWakeLock();
        return;
      }
      item.lastStatus = status;
      if (isPermanentFailure(status)) {
        item.status = 'rejected';
        updateItem(item, rejectedText(status));
      } else {
        item.status = 'error';
        if (status === 401) requireLogin();
        // Offline: no per-item timer; pause the queue until 'online', 再試行 or the 10 s check.
        else if (isOffline()) {
          offlinePause = true;
          scheduleOfflineCheck();
        } else scheduleAutoRetry(item);
        updateItem(item, failedText(item));
      }
      finish();
    },
  });
}

async function start(item) {
  active = item;
  item.status = 'uploading';
  item.startedAt = performance.now();
  item.startOffset = null;
  item.upload ??= createUpload(item);
  updateItem(item, '開始中…');
  await acquireWakeLock();
  try {
    const previous = await item.upload.findPreviousUploads();
    if (previous.length > 0) item.upload.resumeFromPreviousUpload(previous[0]);
  } catch {
    // Resume lookup is best effort; a fresh upload still works.
  }
  item.upload.start();
}

function finish() {
  active = null;
  updateSummary();
  next();
}

function next() {
  if (active) return;
  if (offlinePause && !isOffline()) offlinePause = false;
  // Paused rather than failing item after item: 'online' / a new login continue the queue.
  // The wake lock stays on while the guest waits with queued items.
  if (offlinePause || needsLogin) {
    updateSummary();
    return;
  }
  const item = items.find((i) => i.status === 'queued');
  if (item) {
    start(item);
  } else {
    releaseWakeLock();
  }
}

function requeue(item, label) {
  clearTimeout(item.retryTimer);
  item.retryTimer = null;
  // A fresh tus.Upload: the old one has used up its retryDelays (tus resets them only after
  // progress), so restarting it would give up after a single attempt. start() resumes the new
  // one from the server's offset via the stored fingerprint (findPreviousUploads).
  item.upload = null;
  item.status = 'queued';
  updateItem(item, label);
}

/** While the page stays visible, re-queue a transient failure by itself after a pause. */
function scheduleAutoRetry(item) {
  clearTimeout(item.retryTimer);
  item.retryTimer = null;
  if (!isTransientFailure(item.lastStatus) || item.autoRetries >= MAX_AUTO_RETRIES) return;
  item.retryDelay = autoRetryDelay(item.autoRetries);
  item.retryTimer = setTimeout(() => {
    item.retryTimer = null;
    if (item.status !== 'error') return;
    // Hidden, offline or logged out: visibilitychange / 'online' / the login re-queue it.
    if (document.visibilityState !== 'visible' || isOffline() || needsLogin) {
      updateItem(item, failedText(item));
      return;
    }
    item.autoRetries += 1;
    requeue(item, '待機中(自動で再試行)');
    next();
  }, item.retryDelay);
}

function retry(item) {
  if (item.status !== 'error') return;
  item.autoRetries = 0;
  requeue(item, '待機中');
  // The guest pressed 再試行: try even if navigator.onLine says offline (it can be wrong).
  offlinePause = false;
  next();
}

/** Something changed for the better (screen back, network back, logged in): retry all now. */
function requeueFailed(label) {
  for (const item of items) {
    if (item.status !== 'error') continue;
    item.autoRetries = 0;
    requeue(item, label);
  }
  next();
}

function addFiles(fileList) {
  for (const file of fileList) {
    const item = {
      file,
      status: 'queued',
      upload: null,
      el: null,
      uploadId: null,
      startedAt: 0,
      startOffset: null,
      // Status of the last failure (undefined = network error) and automatic retry state.
      lastStatus: undefined,
      autoRetries: 0,
      retryTimer: null,
      retryDelay: 0,
    };
    items.push(item);
    renderItem(item);
    updateItem(item, '待機中');
  }
  updateSummary();
  next();
}

// --- Wiring ---

async function loadDiagnostics() {
  try {
    const res = await api('/api/whoami');
    if (res.ok) {
      const { ip, viaFunnel } = await res.json();
      $('whoami').textContent =
        `サーバーから見えるIP: ${ip} / Funnel経由: ${viaFunnel ? 'はい' : 'いいえ'}`;
    }
  } catch {
    // Diagnostics are optional.
  }
}

async function fetchSession() {
  // AbortSignal.timeout is missing before Safari 16: fall back to a timer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);
  try {
    const res = await api('/api/session', { signal: controller.signal });
    if (!res.ok) throw new Error(`session: HTTP ${res.status}`);
    // A captive portal or proxy page is not JSON: res.json() throws.
    const session = await res.json();
    if (!session || typeof session !== 'object') throw new Error('session: unexpected body');
    return session;
  } finally {
    clearTimeout(timer);
  }
}

/** Never rejects: a failure shows the 「読み込めませんでした」 screen with a retry button. */
async function init() {
  if (initializing) return;
  initializing = true;
  // Kept as a reference: a closed event replaces the whole page meanwhile.
  const retryButton = $('load-retry');
  retryButton.disabled = true;
  show('loading');
  try {
    let session;
    try {
      session = await fetchSession();
    } catch (err) {
      // 'closed': api() has already replaced the page with the closed notice.
      if (err.message !== 'closed') show('load-error');
      return;
    }
    const {
      authenticated,
      nickname,
      closesAt,
      importing: importEnabled,
      gallery: galleryOn,
      role,
      canDelete,
    } = session;
    importing = Boolean(importEnabled);
    galleryEnabled = Boolean(galleryOn);
    permissions.role = role ?? 'guest';
    permissions.canDelete = Boolean(canDelete);
    $('closes-at').textContent = `受付期限: ${new Date(closesAt).toLocaleString('ja-JP')}`;
    if (authenticated) {
      needsLogin = false;
      setGreeting(nickname);
      enterApp();
      loadDiagnostics();
    } else {
      $('nickname').value = recallNickname();
      show('login');
    }
  } finally {
    initializing = false;
    retryButton.disabled = false;
  }
}

/** Login failures other than 400/401/429 (410 = closed is handled by api()). */
function loginFailureText(status) {
  if (status === 408 || status >= 500) {
    return `通信エラーです(${status})。電波の良い場所で、少し待ってからもう一度お試しください。`;
  }
  if (status === 403) return 'ページを再読み込みしてから、もう一度お試しください。';
  return `ログインできませんでした(${status})。もう一度お試しください。`;
}

async function submitLogin() {
  let res;
  try {
    res = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: $('nickname').value, password: $('password').value }),
    });
  } catch (err) {
    if (err.message !== 'closed') {
      $('login-error').textContent = '通信エラーです。電波の良い場所でもう一度お試しください。';
    }
    return;
  }
  if (res.ok) {
    $('password').value = '';
    const { role } = await res.json().catch(() => ({}));
    permissions.role = role ?? 'guest';
    permissions.sessionId += 1;
    const nickname = $('nickname').value.trim();
    rememberNickname(nickname);
    setGreeting(nickname);
    enterApp();
    loadDiagnostics();
    settleOrphanedImports();
    needsLogin = false;
    requeueFailed('待機中(再ログイン後に再開)');
  } else if (res.status === 401) {
    $('login-error').textContent = '合言葉が違います。';
  } else if (res.status === 429) {
    const { error } = await res.json().catch(() => ({}));
    $('login-error').textContent =
      error === 'busy'
        ? '処理中です。少し待ってからもう一度お試しください。'
        : '試行回数が多すぎます。しばらく待ってから再度お試しください。';
  } else if (res.status === 400) {
    const { error } = await res.json().catch(() => ({}));
    $('login-error').textContent =
      error === 'bad_nickname'
        ? 'ニックネームは1〜20文字で入力してください。'
        : '入力内容を確認してください。';
  } else {
    $('login-error').textContent = loginFailureText(res.status);
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  // One login request at a time; the server rejects overlapping attempts as 'busy'.
  if (button.disabled) return;
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    await submitLogin();
  } finally {
    button.disabled = false;
  }
});

$('tab-upload').addEventListener('click', () => showTab('upload'));
$('tab-gallery').addEventListener('click', () => showTab('gallery'));

$('files').addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});

$('load-retry').addEventListener('click', () => init());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // The closed page replaces the body, so the element may be gone.
  if ($('load-error')?.hidden === false) {
    init();
    return;
  }
  if (active) acquireWakeLock();
  // Uploads that died while the screen was off resume from the last confirmed offset.
  requeueFailed('待機中(再開)');
  schedulePoll();
});

window.addEventListener('online', () => {
  // The closed page replaces the body, so the element may be gone.
  if ($('load-error')?.hidden === false) {
    init();
    return;
  }
  // Also starts the items that were left queued while offline.
  offlinePause = false;
  requeueFailed('待機中(通信が戻ったので再開)');
  schedulePoll();
});

window.addEventListener('offline', updateSummary);

// Fire-and-forget: init() never rejects (failures show the load-error screen).
init();
