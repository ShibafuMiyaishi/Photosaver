#!/usr/bin/env node
// scripts/generate-hash.mjs
// bcrypt 10 ラウンドでパスワードハッシュを生成する。
// album-guard が起動していないときの代替手段(API /album-guard/hash が使えない場合)。
//
// 使い方:
//   node scripts/generate-hash.mjs                        # stdin からパスワード読み取り(推奨)
//   echo 'my-password' | node scripts/generate-hash.mjs
//   node scripts/generate-hash.mjs --password my-password # 引数(shell history に残るので注意)

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

function resolveBcrypt() {
  const guardPath = path.resolve(__dirname, '..', 'album-guard');
  const attempt = path.join(guardPath, 'node_modules', 'bcryptjs');
  try {
    return require(attempt);
  } catch (_e) {
    console.error(
      '❌ bcryptjs が見つかりません。先に album-guard/ で `npm install` を実行してください。',
    );
    process.exit(2);
  }
}

async function readFromStdin() {
  if (process.stdin.isTTY) {
    // Prompt user (password hidden by setting echo off is ideal but complex cross-platform)
    process.stdout.write('password: ');
    const rl = readline.createInterface({ input: process.stdin });
    return new Promise((resolve) => {
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
    });
  }
  // Piped stdin
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--password');
  if (i >= 0 && args[i + 1]) {
    console.warn(
      '⚠️  --password 引数は shell history に残ります。stdin 経由を推奨します。',
    );
    return args[i + 1];
  }
  return null;
}

async function main() {
  const bcrypt = resolveBcrypt();
  const fromArg = parseArgs();
  const pw = fromArg ?? (await readFromStdin());
  if (!pw) {
    console.error('❌ パスワードが空です。');
    process.exit(1);
  }
  const hash = await bcrypt.hash(pw, 10);
  // ハッシュのみを出力(album-passwords.json の hash フィールドに貼る)。
  process.stdout.write(hash + '\n');
}

main().catch((e) => {
  console.error('fatal:', e.stack || e.message);
  process.exit(2);
});
