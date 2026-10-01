// guest-gateway/public/app.js
// ゲスト用画面: ニックネーム + 合言葉でログイン → tus で 1 件ずつアップロード(進捗・所要時間・速度を表示)
// → 送信後はサーバー側の取り込み状態をポーリングし、アルバムに入ったかを表示する。
// iOS は画面ロックやアプリ切替で通信が止まるため、画面に戻ったら失敗分を自動で再開する。

/* global tus */

import { initGallery } from './gallery.js';

const CSRF_HEADERS = { 'X-Requested-With': 'guest-gateway' };
const CHUNK_SIZE = 50 * 1024 * 1024;
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10000, 20000, 30000];
const POLL_INTERVAL_MS = 3000;
// Must not exceed MAX_STATUS_IDS in src/app.js.
const POLL_BATCH = 100;
const NICKNAME_KEY = 'gw-nickname';

const $ = (id) => document.getElementById(id);
const items = [];
let active = null;
let wakeLock = null;
// True when the server imports into Immich (false in the speed-test mode).
let importing = false;
let pollTimer = null;
// Set once the server reports the gallery (import mode).
let galleryEnabled = false;
let gallery = null;

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
  $('login').hidden = section !== 'login';
  $('uploader').hidden = section !== 'uploader';
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
  $('summary').textContent =
    `完了 ${count('done')} / ${items.length} 件` +
    (adding ? `(アルバムに追加中 ${adding} 件)` : '') +
    (failed ? `(失敗 ${failed} 件 — 再試行できます)` : '') +
    (rejected ? `(受付不可 ${rejected} 件)` : '');
}

function showTab(name) {
  $('upload-pane').hidden = name !== 'upload';
  $('gallery').hidden = name !== 'gallery';
  $('tab-upload').setAttribute('aria-pressed', String(name === 'upload'));
  $('tab-gallery').setAttribute('aria-pressed', String(name === 'gallery'));
  if (name === 'gallery') {
    gallery ??= initGallery(api);
    gallery.show();
  }
}

function enterApp() {
  show('uploader');
  $('tabs').hidden = !galleryEnabled;
  showTab('upload');
}

function setGreeting(nickname) {
  $('greeting').textContent = nickname ? `${nickname} さん、ようこそ` : '';
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
      show('login');
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

// Failures that re-sending the same file cannot fix (refused by the server).
// 401 → re-login, 409/423 → offset/lock conflicts, 5xx/network → transient: all retryable.
function isPermanentFailure(status) {
  if (status === 507) return true;
  if (!status || status < 400 || status >= 500) return false;
  return ![401, 409, 423].includes(status);
}

function rejectedText(status) {
  if (status === 507) return '受付不可(507)— サーバーの保存容量が不足しています';
  if (status === 413) return '受付不可(413)— ファイルが大きすぎます';
  if (status === 415) return '受付不可(415)— 対応していない形式のファイルです';
  return `受付不可(${status})— このファイルはサーバーに受け付けられませんでした`;
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
    fingerprint: async (file) => ['gw', file.name, file.size].join(':'),
    removeFingerprintOnSuccess: true,
    onProgress(bytesSent, bytesTotal) {
      if (item.startOffset === null) item.startOffset = bytesSent;
      item.el.bar.value = bytesTotal ? (bytesSent / bytesTotal) * 100 : 0;
      updateItem(
        item,
        `送信中 ${formatBytes(bytesSent)} / ${formatBytes(bytesTotal)} — ${speedText(item, bytesSent)}`,
      );
    },
    onSuccess({ lastResponse }) {
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
      if (status === 401) {
        show('login');
      }
      if (isPermanentFailure(status)) {
        item.status = 'rejected';
        updateItem(item, rejectedText(status));
      } else {
        item.status = 'error';
        updateItem(item, `失敗(${status ?? '通信エラー'})— 画面に戻ると自動で再開します`);
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
  const item = items.find((i) => i.status === 'queued');
  if (item) {
    start(item);
  } else {
    releaseWakeLock();
  }
}

function retry(item) {
  if (item.status !== 'error') return;
  item.status = 'queued';
  updateItem(item, '待機中');
  next();
}

function requeueFailed(label) {
  for (const item of items) {
    if (item.status === 'error') {
      item.status = 'queued';
      updateItem(item, label);
    }
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

async function init() {
  const res = await api('/api/session');
  const {
    authenticated,
    nickname,
    closesAt,
    importing: importEnabled,
    gallery: galleryOn,
  } = await res.json();
  importing = Boolean(importEnabled);
  galleryEnabled = Boolean(galleryOn);
  $('closes-at').textContent = `受付期限: ${new Date(closesAt).toLocaleString('ja-JP')}`;
  if (authenticated) {
    setGreeting(nickname);
    enterApp();
    loadDiagnostics();
  } else {
    $('nickname').value = recallNickname();
    show('login');
  }
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
    const nickname = $('nickname').value.trim();
    rememberNickname(nickname);
    setGreeting(nickname);
    enterApp();
    loadDiagnostics();
    settleOrphanedImports();
    requeueFailed('待機中(再ログイン後に再開)');
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
    $('login-error').textContent = '合言葉が違います。';
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (active) acquireWakeLock();
  // Uploads that died while the screen was off resume from the last confirmed offset.
  requeueFailed('待機中(再開)');
  schedulePoll();
});

init().catch(() => {});
