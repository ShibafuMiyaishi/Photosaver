#!/usr/bin/env node
// scripts/check-drive.mjs
// 外付けドライブ(PHOTO_STORAGE_PATH)の到達性・書込可・空き容量・Docker file sharing を検証。
// Exit codes:
//   0 = すべての check が pass
//   1 = どこかの check で fail(ユーザー対処が必要)
//   2 = スクリプト実行環境の問題(Node バージョン等)

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadEnv } from './_env.mjs';

const FREE_SPACE_WARN_GB = 5;

function log(icon, msg) {
  console.log(`${icon}  ${msg}`);
}

async function main() {
  loadEnv();
  const storagePath = process.env.PHOTO_STORAGE_PATH;
  if (!storagePath) {
    log('❌', 'PHOTO_STORAGE_PATH が設定されていません。.env を確認してください。');
    process.exit(1);
  }
  console.log(`\n📦 drive-check target: ${storagePath}\n`);

  let allPass = true;

  // 1. Path exists & is dir
  let stat;
  try {
    stat = fs.statSync(storagePath);
    if (!stat.isDirectory()) {
      log('❌', `${storagePath} is not a directory`);
      allPass = false;
    } else {
      log('✅', 'path exists & is a directory');
    }
  } catch (_e) {
    log('❌', `${storagePath} does not exist. ドライブが接続されているか確認してください。`);
    allPass = false;
    finish(allPass);
    return;
  }

  // 2. Writable
  const marker = path.join(storagePath, `.drive-check-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(marker, 'ok');
    fs.unlinkSync(marker);
    log('✅', 'writable');
  } catch (e) {
    log('❌', `not writable: ${e.message}`);
    allPass = false;
  }

  // 3. Expected layout
  for (const sub of ['immich-library', 'guard']) {
    const p = path.join(storagePath, sub);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      log('✅', `exists: ${sub}/`);
    } else {
      log('⚠️ ', `missing: ${sub}/ (mkdir で自動作成可)`);
      allPass = false;
    }
  }

  // 4. Free space
  try {
    const s = fs.statfsSync(storagePath);
    const freeGb = (s.bfree * s.bsize) / 1024 / 1024 / 1024;
    if (freeGb < FREE_SPACE_WARN_GB) {
      log('⚠️ ', `free space: ${freeGb.toFixed(2)} GB (< ${FREE_SPACE_WARN_GB} GB — 容量確保を推奨)`);
    } else {
      log('✅', `free space: ${freeGb.toFixed(2)} GB`);
    }
  } catch (e) {
    log('⚠️ ', `free space check skipped: ${e.message}`);
  }

  // 5. Docker file sharing probe (optional, only if --docker flag or DOCKER_CHECK=1)
  const shouldProbe = process.argv.includes('--docker') || process.env.DOCKER_CHECK === '1';
  if (shouldProbe) {
    try {
      const mountPath = storagePath.replace(/\\/g, '/');
      const out = execSync(`docker run --rm -v "${mountPath}":/x alpine ls /x`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (out.trim()) {
        log('✅', 'Docker Desktop File Sharing OK');
      } else {
        log('❌', 'Docker でマウントしたがディレクトリが空に見える(File Sharing 未設定の可能性)');
        allPass = false;
      }
    } catch (e) {
      log(
        '❌',
        `Docker probe 失敗: ${e.message.split('\n')[0]}\n    → Docker Desktop → Settings → Resources → File sharing に ${storagePath} のドライブを追加してください`,
      );
      allPass = false;
    }
  } else {
    log('ℹ️ ', 'Docker probe skipped (--docker フラグで有効化)');
  }

  finish(allPass);
}

function finish(allPass) {
  console.log('');
  if (allPass) {
    console.log('✅ all checks passed');
    process.exit(0);
  } else {
    console.log('❌ one or more checks failed — 上記メッセージに従って対処してください');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('fatal:', e.stack || e.message);
  process.exit(2);
});
