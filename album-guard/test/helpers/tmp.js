// album-guard/test/helpers/tmp.js
// テスト成果物は repo 直下の tmp/ に集約する(.claude/rules/testing.md)。
// システムの /tmp は使わない。

const fs = require('node:fs');
const path = require('node:path');

// album-guard/test/helpers/ から repo root の tmp/ まで ../../../tmp
const TMP = path.resolve(__dirname, '..', '..', '..', 'tmp');
const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');

function ensureTmpRoot() {
  fs.mkdirSync(TMP, { recursive: true });
}

function mktmp(subdir) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(TMP, 'test', subdir, unique);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Node's require.cache を src/ 配下のみ bust する。
// vi.resetModules() は Vitest の ESM registry のみを clear し、
// CJS テストから require() したモジュールは cache に残るため、ここで明示的に掃除する。
function bustSrcCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(SRC_DIR)) delete require.cache[k];
  }
}

module.exports = { TMP, ensureTmpRoot, mktmp, bustSrcCache };
