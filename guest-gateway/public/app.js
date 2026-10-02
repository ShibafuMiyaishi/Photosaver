// guest-gateway/public/app.js
// ゲスト用画面: ニックネーム + 合言葉でログイン → tus で 1 件ずつアップロード(進捗・所要時間・速度を表示)
// → 送信後はサーバー側の取り込み状態をポーリングし、アルバムに入ったかを表示する。
// 通信の失敗は自動で再開する: 画面に戻ったとき(iOS は画面ロックやアプリ切替で通信が止まる)、
// 電波が戻ったとき(オフラインの間は次の 1 件に進まず待つ)、画面を開いたままなら間隔を空けて。
// 画面を開いたまま 90 秒なにも進まない送信は打ち切って、同じく自動で再開する。
// 端末側で読めなくなったファイルはやり直さず、選び直してもらう。
// 最初の読み込みに失敗したら「読み込めませんでした」と再読み込みボタンを出す。
// 受付終了(410)を受けたら画面を差し替え、ポーリングや再試行のタイマーをすべて止める。

/* global tus */

import { initGallery } from './gallery.js';
import { loginBusyDelay } from './login-retry.js';
import {
  autoRetryDelay,
  canReadFile,
  classifyUploadError,
  fileKey,
  isTransientFailure,
  MAX_AUTO_RETRIES,
  nextStatusMisses,
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
// An upload with no progress, success or error for this long while the page is visible is
// aborted and retried (a stalled connection that neither fails nor moves).
const STALL_TIMEOUT_MS = 90_000;
const STALL_CHECK_MS = 5_000;
const SECTIONS = ['loading', 'load-error', 'login', 'uploader'];
// Statuses during which picking the same file again is skipped.
const IN_QUEUE = new Set(['queued', 'uploading', 'importing']);

const CLOSED_TEXT = 'このアップロード窓口は受付を終了しました。';
const UNREADABLE_TEXT =
  'このファイルを読み込めませんでした。お手数ですが「写真・動画を選ぶ」からもう一度選び直してください';
const RECEIVED_TEXT = '受け付けました(アルバムへの追加はサーバー側で続いています)';

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
// Set once the server answered 410: nothing may be scheduled any more.
let closed = false;
let stallTimer = null;
// Set when the page was hidden (or frozen) at any time since the last stall check: iOS can
// freeze the page right after hiding it, and on resume a pending check may run before the
// visibilitychange handler has restarted the activity clock.
let hiddenSinceStallCheck = false;

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
  offlineCheckTimer = null;
  if (closed) return;
  offlineCheckTimer = setTimeout(() => {
    offlineCheckTimer = null;
    if (!offlinePause || closed) return;
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

/**
 * The event is over (410): replace the page and stop every timer and the running upload, so
 * nothing keeps polling or re-sending to a closed server.
 */
function closePage() {
  if (!closed) {
    closed = true;
    clearTimeout(pollTimer);
    pollTimer = null;
    clearTimeout(offlineCheckTimer);
    offlineCheckTimer = null;
    clearTimeout(stallTimer);
    stallTimer = null;
    for (const item of items) {
      clearTimeout(item.retryTimer);
      item.retryTimer = null;
    }
    const upload = active?.upload;
    active = null;
    upload?.abort().catch(() => {});
    releaseWakeLock();
  }
  document.body.textContent = CLOSED_TEXT;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...CSRF_HEADERS, ...(options.headers ?? {}) },
  });
  if (res.status === 410) {
    closePage();
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
  bar.setAttribute('aria-label', `${item.file.name} の送信状況`);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const info = document.createElement('div');
  info.className = 'meta';
  li.append(name, bar, meta, info);
  item.el = { li, bar, meta, info };
  renderInfo(item);
  $('queue').append(li);
}

function renderInfo(item) {
  const modified = new Date(item.file.lastModified).toLocaleString('ja-JP');
  item.el.info.textContent = `${item.file.type || '種類不明'} / ${formatBytes(item.file.size)} / 更新日時 ${modified}`;
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
  if (closed) return;
  const count = (status) => items.filter((i) => i.status === status).length;
  const failed = count('error');
  const rejected = count('rejected');
  const unreadable = count('unreadable');
  const adding = count('importing');
  const waiting = items.some((i) => i.status === 'queued' || i.status === 'error');
  $('summary').textContent =
    `完了 ${count('done')} / ${items.length} 件` +
    (adding ? `(アルバムに追加中 ${adding} 件)` : '') +
    (failed ? `(失敗 ${failed} 件 — 再試行できます)` : '') +
    (rejected ? `(受付不可 ${rejected} 件)` : '') +
    (unreadable ? `(読み込めなかったファイル ${unreadable} 件 — 選び直してください)` : '') +
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
    gallery ??= initGallery(api, { onUnauthorized: requireLogin, onClosed: closePage });
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
  const admin =
    permissions.role === 'admin' ? '(管理者モード: このページから上がった写真を削除できます)' : '';
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
function uploadIdOf(upload) {
  try {
    return new URL(upload.url, document.baseURI).pathname.split('/').pop() || null;
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
  if (closed || pollTimer || !items.some((i) => i.status === 'importing' && i.uploadId)) return;
  pollTimer = setTimeout(pollImports, POLL_INTERVAL_MS);
}

async function pollImports() {
  pollTimer = null;
  const waiting = items.filter((i) => i.status === 'importing' && i.uploadId).slice(0, POLL_BATCH);
  if (waiting.length === 0 || closed) return;
  try {
    const ids = waiting.map((i) => encodeURIComponent(i.uploadId)).join(',');
    const res = await api(`/api/uploads?ids=${ids}`);
    if (res.status === 401) {
      requireLogin();
      return;
    }
    if (res.ok) {
      const { uploads } = await res.json();
      const byId = new Map(uploads.map((u) => [u.id, u.status]));
      for (const item of waiting) {
        if (item.status !== 'importing') continue;
        const result = IMPORT_RESULT[byId.get(item.uploadId)];
        if (result) {
          item.status = result.status;
          updateItem(item, result.text);
          continue;
        }
        // Not listed (or still pending): stop asking after a few answers that leave it out.
        const { misses, giveUp } = nextStatusMisses(item.statusMisses, byId.has(item.uploadId));
        item.statusMisses = misses;
        if (giveUp) {
          item.status = 'done';
          updateItem(item, RECEIVED_TEXT);
        }
      }
      updateSummary();
    }
  } catch (err) {
    // 'closed': the page has been replaced; nothing is scheduled any more.
    if (err?.message === 'closed') return;
    // Network hiccup: try again on the next tick.
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
  const cause = item.stalled ? '応答がありません' : (item.lastStatus ?? '通信エラー');
  const head = `失敗(${cause})— `;
  if (item.lastStatus === 401) return `${head}もう一度ログインすると再開します`;
  if (isOffline()) return `${head}電波が戻ると自動で再開します`;
  if (item.retryTimer)
    return `${head}約${Math.round(item.retryDelay / 1000)}秒後に自動で再試行します`;
  return `${head}「再試行」を押すとやり直します(画面を開き直したときも再開します)`;
}

function speedText(item, bytesSent) {
  const elapsed = performance.now() - item.startedAt;
  const sent = bytesSent - (item.startOffset ?? bytesSent);
  const mbps = elapsed > 0 ? (sent * 8) / elapsed / 1000 : 0;
  return `${formatSeconds(elapsed)} / ${mbps.toFixed(1)} Mbps`;
}

/** Speed of this attempt, or a note when the server already had the whole file. */
function sentSummary(item) {
  const sentNow = item.startOffset === null ? 0 : item.file.size - item.startOffset;
  return sentNow > 0 || item.file.size === 0 ? speedText(item, item.file.size) : '送信済みでした';
}

function noteActivity(item) {
  item.lastActivity = performance.now();
}

/**
 * Look at the file once more after a network-type error; sets item.unreadable. A probe that
 * finishes after the guest picked the file again (replaceFile) leaves the item alone.
 */
function probeFile(item) {
  if (item.probing) return item.probing;
  const file = item.file;
  const probing = canReadFile(file).then((ok) => {
    if (item.probing === probing) item.probing = null;
    if (item.file === file) item.unreadable = !ok;
    return ok;
  });
  item.probing = probing;
  return probing;
}

function createUpload(item) {
  // Callbacks of an upload that was aborted (stall, closed) or replaced must not touch the item.
  const isCurrent = () => item.upload === upload && item.status === 'uploading' && !closed;
  const upload = new tus.Upload(item.file, {
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
    // A request without a response may also be a file the browser cannot read any more (it
    // reads lazily while sending): check the file meanwhile and stop retrying if so.
    onShouldRetry(err) {
      if (!isCurrent()) return false;
      noteActivity(item);
      if (!err.originalResponse) probeFile(item);
      return classifyUploadError(err, { fileReadable: !item.unreadable }).kind === 'transient';
    },
    // A chunk the server confirmed proves the network works (see noteNetworkWorks).
    onChunkComplete() {
      if (!isCurrent()) return;
      noteActivity(item);
      noteNetworkWorks();
    },
    onProgress(bytesSent, bytesTotal) {
      if (!isCurrent()) return;
      noteActivity(item);
      if (item.startOffset === null) item.startOffset = bytesSent;
      item.el.bar.value = bytesTotal ? (bytesSent / bytesTotal) * 100 : 0;
      updateItem(
        item,
        `送信中 ${formatBytes(bytesSent)} / ${formatBytes(bytesTotal)} — ${speedText(item, bytesSent)}`,
      );
    },
    // Also reached without any progress event: a resumed upload the server already holds in
    // full (HEAD answers Upload-Offset == Upload-Length) succeeds without sending anything.
    onSuccess({ lastResponse }) {
      if (!isCurrent()) return;
      noteNetworkWorks();
      item.el.bar.value = 100;
      const uploadId = uploadIdOf(upload);
      if (importing && uploadId) {
        item.status = 'importing';
        item.uploadId = uploadId;
        item.statusMisses = 0;
        updateItem(item, `送信完了(${sentSummary(item)})— アルバムに追加中…`);
        schedulePoll();
      } else if (importing) {
        // No id to ask about (should not happen): do not leave it on 「追加中」 forever.
        item.status = 'done';
        updateItem(item, RECEIVED_TEXT);
      } else {
        item.status = 'done';
        const detected = lastResponse?.getHeader('X-GW-Detected-Type') ?? '?';
        updateItem(item, `完了 — ${sentSummary(item)} / 判定 ${detected}`);
      }
      finish();
    },
    onError(err) {
      if (!isCurrent()) return;
      // Fire-and-forget: handleUploadError never rejects.
      handleUploadError(item, upload, err);
    },
  });
  return upload;
}

async function handleUploadError(item, upload, err) {
  let fileReadable = !item.unreadable;
  // No response at all: maybe the network, maybe the file (see classifyUploadError).
  if (fileReadable && !err?.originalResponse) fileReadable = await probeFile(item);
  if (item.upload !== upload || item.status !== 'uploading' || closed) return;
  const { kind, status } = classifyUploadError(err, { fileReadable });
  if (kind === 'closed') {
    closePage();
    return;
  }
  item.lastStatus = status;
  if (kind === 'unreadable') markUnreadable(item);
  else if (kind === 'permanent') {
    item.status = 'rejected';
    updateItem(item, rejectedText(status));
  } else failTransient(item);
  finish();
}

/** The browser cannot read the file any more: re-sending cannot help, the guest picks it again. */
function markUnreadable(item) {
  item.status = 'unreadable';
  item.upload = null;
  item.el.bar.value = 0;
  updateItem(item, UNREADABLE_TEXT);
}

/** A failure that may go away (network, 5xx, busy, 401, stall): wait and retry. */
function failTransient(item) {
  item.status = 'error';
  if (item.lastStatus === 401) requireLogin();
  // Offline: no per-item timer; pause the queue until 'online', 再試行 or the 10 s check.
  else if (isOffline()) {
    offlinePause = true;
    scheduleOfflineCheck();
  } else scheduleAutoRetry(item);
  updateItem(item, failedText(item));
}

// --- Stall watchdog (only the active upload; paused while the page is hidden) ---

function scheduleStallCheck() {
  clearTimeout(stallTimer);
  stallTimer = closed || !active ? null : setTimeout(checkStall, STALL_CHECK_MS);
}

function checkStall() {
  stallTimer = null;
  const item = active;
  if (!item || closed || item.status !== 'uploading') return;
  const now = performance.now();
  const wasHidden = hiddenSinceStallCheck || document.visibilityState !== 'visible';
  // Still hidden: the next check must not count this interval either.
  hiddenSinceStallCheck = document.visibilityState !== 'visible';
  // iOS stops the page (and its sockets) while hidden: that is not a stall.
  if (wasHidden) item.lastActivity = now;
  else if (now - item.lastActivity >= STALL_TIMEOUT_MS) {
    abortStalled(item);
    return;
  }
  scheduleStallCheck();
}

/** Nothing moved for STALL_TIMEOUT_MS: abort and let the automatic retry resume it. */
function abortStalled(item) {
  const upload = item.upload;
  // Detach first: abort() emits nothing, but no late callback may touch the item either.
  item.upload = null;
  upload?.abort().catch(() => {});
  item.lastStatus = undefined;
  item.stalled = true;
  failTransient(item);
  finish();
}

async function start(item) {
  active = item;
  item.status = 'uploading';
  item.startedAt = performance.now();
  item.startOffset = null;
  item.stalled = false;
  noteActivity(item);
  scheduleStallCheck();
  updateItem(item, '開始中…');
  await acquireWakeLock();
  // iOS may have dropped the picked file meanwhile (e.g. while the tab was suspended).
  const readable = await probeFile(item);
  if (closed || active !== item || item.status !== 'uploading') return;
  if (!readable) {
    markUnreadable(item);
    finish();
    return;
  }
  item.upload ??= createUpload(item);
  const { upload } = item;
  try {
    const previous = await upload.findPreviousUploads();
    if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
  } catch {
    // Resume lookup is best effort; a fresh upload still works.
  }
  if (closed || item.upload !== upload || item.status !== 'uploading') return;
  noteActivity(item);
  upload.start();
}

function finish() {
  active = null;
  clearTimeout(stallTimer);
  stallTimer = null;
  updateSummary();
  next();
}

function next() {
  if (active || closed) return;
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
  if (closed || !isTransientFailure(item.lastStatus) || item.autoRetries >= MAX_AUTO_RETRIES) {
    return;
  }
  item.retryDelay = autoRetryDelay(item.autoRetries);
  item.retryTimer = setTimeout(() => {
    item.retryTimer = null;
    if (item.status !== 'error' || closed) return;
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
  if (item.status !== 'error' || closed) return;
  item.autoRetries = 0;
  requeue(item, '待機中');
  // The guest pressed 再試行: try even if navigator.onLine says offline (it can be wrong).
  offlinePause = false;
  next();
}

/** Something changed for the better (screen back, network back, logged in): retry all now. */
function requeueFailed(label) {
  if (closed) return;
  for (const item of items) {
    if (item.status !== 'error') continue;
    item.autoRetries = 0;
    requeue(item, label);
  }
  next();
}

function newItem(file) {
  return {
    file,
    key: fileKey(file),
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
    // Stall watchdog, unreadable-file probe, status polls that did not mention this upload.
    lastActivity: 0,
    stalled: false,
    unreadable: false,
    probing: null,
    statusMisses: 0,
  };
}

/** The same file picked again for an item that failed: send it with the fresh File handle. */
function replaceFile(item, file) {
  clearTimeout(item.retryTimer);
  item.retryTimer = null;
  item.file = file;
  item.unreadable = false;
  item.probing = null;
  item.autoRetries = 0;
  item.upload = null;
  item.status = 'queued';
  renderInfo(item);
  updateItem(item, '待機中(選び直したファイル)');
}

function addFiles(fileList) {
  if (closed) return;
  let skipped = 0;
  for (const file of fileList) {
    const key = fileKey(file);
    const existing = items.find(
      (i) => i.key === key && i.status !== 'done' && i.status !== 'rejected',
    );
    if (existing && IN_QUEUE.has(existing.status)) {
      skipped += 1;
      continue;
    }
    if (existing) {
      // 'error' or 'unreadable': one row per file; the newly picked handle replaces the old one.
      replaceFile(existing, file);
      continue;
    }
    const item = newItem(file);
    items.push(item);
    renderItem(item);
    updateItem(item, '待機中');
  }
  $('pick-note').textContent =
    skipped > 0
      ? `同じファイルが送信待ち・送信中・追加中のため、${skipped} 件は追加しませんでした`
      : '';
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
  if (initializing || closed) return;
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

// The server runs only a few password checks per address at a time (scrypt takes ~0.3 s), so
// guests sharing the venue Wi-Fi often get 429 'busy' in a rush. Retry those quietly for a while
// (timing in login-retry.js); the original form values are sent each time.
/** Read the 429 error code without consuming the response for later readers. */
async function loginErrorCode(res) {
  const { error } = await res
    .clone()
    .json()
    .catch(() => ({}));
  return error;
}

async function submitLogin() {
  let res;
  const body = JSON.stringify({ nickname: $('nickname').value, password: $('password').value });
  const startedAt = performance.now();
  try {
    for (let retry = 1; ; retry += 1) {
      res = await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      // 429 busy: another check from this address is running. 503 unavailable: the password
      // check itself failed (e.g. memory pressure) and was not counted. Both clear up shortly.
      const code = res.status === 429 || res.status === 503 ? await loginErrorCode(res) : null;
      if (
        !(res.status === 429 && code === 'busy') &&
        !(res.status === 503 && code === 'unavailable')
      ) {
        break;
      }
      const delay = loginBusyDelay({
        retry,
        elapsedMs: performance.now() - startedAt,
        retryAfter: res.headers.get('Retry-After'),
      });
      if (delay === null) break;
      $('login-error').textContent = `混み合っています。自動でもう一度試しています…(${retry} 回目)`;
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
  } catch (err) {
    if (err.message !== 'closed') {
      $('login-error').textContent = '通信エラーです。電波の良い場所でもう一度お試しください。';
    }
    return;
  }
  $('login-error').textContent = '';
  if (res.ok) {
    $('password').value = '';
    const { role, nickname: normalized } = await res.json().catch(() => ({}));
    permissions.role = role ?? 'guest';
    permissions.sessionId += 1;
    // The server's normalized nickname (what others see); older servers do not send it.
    const nickname =
      typeof normalized === 'string' && normalized ? normalized : $('nickname').value.trim();
    $('nickname').value = nickname;
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
        ? '混み合っています。少し待ってからもう一度お試しください。'
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

function noteHidden() {
  hiddenSinceStallCheck = true;
}

window.addEventListener('pagehide', noteHidden);
// Page Lifecycle API (Chromium); other browsers never fire it.
document.addEventListener('freeze', noteHidden);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') noteHidden();
  if (closed || document.visibilityState !== 'visible') return;
  if ($('load-error').hidden === false) {
    init();
    return;
  }
  if (active) {
    acquireWakeLock();
    // The stall watchdog starts counting again from now (it pauses while hidden).
    noteActivity(active);
  }
  // Uploads that died while the screen was off resume from the last confirmed offset.
  requeueFailed('待機中(再開)');
  schedulePoll();
});

window.addEventListener('online', () => {
  if (closed) return;
  if ($('load-error').hidden === false) {
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
