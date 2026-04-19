#!/usr/bin/env node
// scripts/verify-env.mjs
// .env と immich/.env に必須変数が埋まっているか、placeholder が残っていないか検証。
// Exit codes:
//   0 = 全キー OK
//   1 = 必須キー未設定 / placeholder 残存
//   2 = .env ファイル自体が見つからない

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PLACEHOLDER_PATTERNS = [/CHANGE_ME/i, /CHANGE_THIS/i, /YOUR_/i, /_HERE$/i];

const REQUIRED = {
  '.env': ['PHOTO_STORAGE_PATH'],
  'immich/.env': [
    'PHOTO_STORAGE_PATH',
    'DB_PASSWORD',
    'GUARD_JWT_SECRET',
    'IMMICH_VERSION',
    'DB_HOSTNAME',
    'DB_USERNAME',
    'DB_DATABASE_NAME',
    'REDIS_HOSTNAME',
  ],
};

const OPTIONAL_BLANK_OK = new Set(['CLOUDFLARE_TUNNEL_TOKEN']);

function parseEnvFile(filepath) {
  const text = fs.readFileSync(filepath, 'utf8');
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    // Strip matching quotes.
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

function main() {
  let allPass = true;

  for (const [rel, keys] of Object.entries(REQUIRED)) {
    const abs = path.join(REPO_ROOT, rel);
    console.log(`\n📄 ${rel}`);
    if (!fs.existsSync(abs)) {
      console.log(`   ❌ not found — cp ${rel}.example ${rel} で作成してください`);
      process.exit(2);
    }
    const env = parseEnvFile(abs);
    for (const key of keys) {
      const v = env[key];
      if (v === undefined) {
        console.log(`   ❌ ${key}: 未定義`);
        allPass = false;
        continue;
      }
      if (v === '' && !OPTIONAL_BLANK_OK.has(key)) {
        console.log(`   ❌ ${key}: 空文字`);
        allPass = false;
        continue;
      }
      if (v !== '' && isPlaceholder(v)) {
        console.log(`   ❌ ${key}: placeholder 値 (${v}) — 実値に置換してください`);
        allPass = false;
        continue;
      }
      if (key === 'GUARD_JWT_SECRET' && v.length < 32) {
        console.log(
          `   ❌ ${key}: 32 文字以上必要(現 ${v.length})。openssl rand -hex 32 で生成`,
        );
        allPass = false;
        continue;
      }
      console.log(`   ✅ ${key}: ok`);
    }
  }

  console.log('');
  if (allPass) {
    console.log('✅ all required env vars OK');
    process.exit(0);
  } else {
    console.log('❌ env に未解決の問題あり — 上記を修正してください');
    process.exit(1);
  }
}

main();
