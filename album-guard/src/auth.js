// album-guard/src/auth.js
// パスワード設定のロード、bcrypt 検証、JWT 発行/検証、ホットリロード。
//
// eslint の security/detect-non-literal-fs-filename は本ファイルでは無効化する。
// fs 操作の対象は全て config.PASSWORDS_FILE(環境変数由来、デプロイヤ管理下)であり、
// ユーザー入力が flow する箇所ではないため、non-literal 警告は偽陽性になる。
/* eslint-disable security/detect-non-literal-fs-filename */

const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let passwordMap = {};
let watcher = null;
let pollInterval = null;
let lastMtimeMs = 0;

// polling interval (ms). テスト環境では短くして待ち時間を削減(setup.js が 200 に設定)。
const POLL_INTERVAL_MS = parseInt(process.env.GUARD_POLL_INTERVAL_MS || '5000', 10);

function loadPasswords() {
  try {
    const raw = fs.readFileSync(config.PASSWORDS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[album-guard] パスワード設定は object である必要があります。空マップで継続。');
      passwordMap = {};
      return;
    }
    passwordMap = parsed;
    const count = Object.keys(passwordMap).filter((k) => UUID_RE.test(k)).length;
    console.log(`[album-guard] パスワード設定をロード: ${count} アルバム`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(
        `[album-guard] パスワード設定ファイルが見つかりません: ${config.PASSWORDS_FILE} ` +
          '(全アルバム通過モード)',
      );
    } else {
      console.warn(
        `[album-guard] パスワード設定の読込に失敗: ${e.message} (全アルバム通過モード)`,
      );
    }
    passwordMap = {};
  }
}

function startWatcher() {
  stopWatcher();
  const target = path.resolve(config.PASSWORDS_FILE);
  const dir = path.dirname(target);
  const filename = path.basename(target);

  // 多層防御: fs.watch(directory) + polling を併用する。
  // 理由: Windows の fs.watch(file) は同一プロセス書き込みで発火しないケースがある。
  // ディレクトリ監視の方が移植性が高い。さらに polling で漏れもカバー。
  try {
    watcher = fs.watch(dir, (_eventType, changedName) => {
      if (changedName !== filename) return;
      setTimeout(loadPasswords, 200);
    });
    watcher.on('error', (err) => {
      console.warn(
        `[album-guard] fs.watch エラー: ${err.message} → polling のみで継続`,
      );
      stopWatcher();
      startPolling();
    });
  } catch (_) {
    // fs.watch が完全に失敗 → polling 単独経路へ。
  }
  // fs.watch が動いている場合も、漏れ対策で polling も並走させる。
  startPolling();
}

function startPolling() {
  if (pollInterval) return;
  try {
    lastMtimeMs = fs.statSync(config.PASSWORDS_FILE).mtimeMs;
  } catch (_) {
    lastMtimeMs = 0;
  }
  pollInterval = setInterval(() => {
    try {
      const m = fs.statSync(config.PASSWORDS_FILE).mtimeMs;
      if (m !== lastMtimeMs) {
        lastMtimeMs = m;
        loadPasswords();
      }
    } catch (_) {
      // ファイル一時的に消失 — 次回ループで復活すれば拾う。
    }
  }, POLL_INTERVAL_MS);
  if (pollInterval.unref) pollInterval.unref();
}

function stopWatcher() {
  if (watcher) {
    try {
      watcher.close();
    } catch (_) {
      // no-op
    }
    watcher = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function isProtected(albumId) {
  return Boolean(passwordMap[albumId]);
}

async function verifyPasswordAndSign(albumId, rawPassword) {
  const entry = passwordMap[albumId];
  if (!entry || typeof entry.hash !== 'string') return null;
  const ok = await bcrypt.compare(rawPassword, entry.hash);
  if (!ok) return null;
  return jwt.sign(
    { albumId, label: entry.label || '' },
    config.JWT_SECRET,
    {
      expiresIn: entry.expiresIn || config.JWT_EXPIRES_IN,
      algorithm: 'HS256',
    },
  );
}

function verifyToken(token, albumId) {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
    });
    return payload.albumId === albumId;
  } catch {
    return false;
  }
}

async function hashPassword(raw) {
  return bcrypt.hash(raw, 10);
}

// Module-load side effects: load + start watch.
loadPasswords();
startWatcher();

module.exports = {
  isProtected,
  verifyPasswordAndSign,
  verifyToken,
  hashPassword,
  // Test-only hooks. Safe to export: they only control the watcher and expose a
  // shallow copy of the internal map. No production code should rely on these.
  _testHooks: {
    reload: loadPasswords,
    stop: stopWatcher,
    start: startWatcher,
    getMap: () => ({ ...passwordMap }),
  },
};
