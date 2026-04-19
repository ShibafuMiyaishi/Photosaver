// album-guard/test/helpers/setup.js
// Vitest の setupFiles — 全テストより前に 1 回だけ走る。
// 各テスト(config.test.js 含む)が必要なら後から vi.resetModules() + 環境変数で上書きする。

const fs = require('node:fs');
const path = require('node:path');
const { ensureTmpRoot, TMP } = require('./tmp');

// デフォルトの JWT シークレット(テスト専用、64 char)。
if (!process.env.GUARD_JWT_SECRET) {
  process.env.GUARD_JWT_SECRET = 'a'.repeat(64);
}

// テスト用: polling 間隔を短くして hot-reload テストの待ち時間を削減。
if (!process.env.GUARD_POLL_INTERVAL_MS) {
  process.env.GUARD_POLL_INTERVAL_MS = '200';
}

ensureTmpRoot();

// デフォルトのパスワードファイルを tmp/test/default/ に置く。
// auth.js は require 時に loadPasswords() を呼ぶため、先に存在させておく必要がある。
const DEFAULT_DIR = path.join(TMP, 'test', 'default');
fs.mkdirSync(DEFAULT_DIR, { recursive: true });
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'album-passwords.json');
if (!fs.existsSync(DEFAULT_FILE)) {
  fs.writeFileSync(DEFAULT_FILE, '{}');
}
if (!process.env.GUARD_PASSWORDS_FILE) {
  process.env.GUARD_PASSWORDS_FILE = DEFAULT_FILE;
}
