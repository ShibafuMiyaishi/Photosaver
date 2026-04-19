// album-guard/test/fixtures/passwords.js
// 実ハッシュを含む fixture をテスト実行時に動的生成する(事前計算された固定ハッシュより
// 分かりやすく、plaintext との対応関係がソース上で明確)。

const bcrypt = require('bcryptjs');

const ENTRIES = {
  '550e8400-e29b-41d4-a716-446655440000': {
    label: 'family',
    plaintext: 'correct-horse',
    expiresIn: '72h',
  },
  '660f9511-f3ac-52e5-b827-557766551111': {
    label: 'wedding',
    plaintext: 'battery-staple',
    expiresIn: '168h',
  },
};

async function buildFixture() {
  const out = {};
  for (const [uuid, e] of Object.entries(ENTRIES)) {
    out[uuid] = {
      label: e.label,
      hash: await bcrypt.hash(e.plaintext, 10),
      expiresIn: e.expiresIn,
    };
  }
  return out;
}

module.exports = { ENTRIES, buildFixture };
