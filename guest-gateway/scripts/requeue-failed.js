// guest-gateway/scripts/requeue-failed.js
// 取り込みに失敗したファイルの復旧。取り込みキューは諦めたファイルを消さずにステージングの failed/ へ移すので、
// 原因(共有リンクのアップロード許可を切った・作り直した、Immich の長時間停止など)を直したあと、
// ここで取り込み待ちに戻し、窓口を作り直す(再起動する)と取り込みが再開する。
// 表示は件数と ID だけ(ニックネームやファイル名は出さない)。動いている窓口コンテナの中で実行する:
//   docker exec guest_gateway node scripts/requeue-failed.js           # 確認のみ(何も変えない)
//   docker exec guest_gateway node scripts/requeue-failed.js --apply   # failed/ → importing/ に戻す

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { SAFE_ID } from '../src/importer.js';
import { openStore } from '../src/store.js';
import { FAILED_DIR_NAME, IMPORT_DIR_NAME } from '../src/uploads.js';
import { formatBytes } from './event-status.js';

const LOCATION_LABELS = {
  failed: 'failed/ にあり',
  importing: 'importing/ に残っている',
  missing: 'ファイルなし',
};

async function isFile(filePath) {
  return (await fs.stat(filePath).catch(() => null))?.isFile() ?? false;
}

/** Where a given-up file is: failed/ (normal), importing/ (the move failed) or nowhere. */
async function locate(stagingDir, uploadId) {
  if (!SAFE_ID.test(uploadId)) return 'missing';
  if (await isFile(path.join(stagingDir, FAILED_DIR_NAME, uploadId))) return 'failed';
  if (await isFile(path.join(stagingDir, IMPORT_DIR_NAME, uploadId))) return 'importing';
  return 'missing';
}

/**
 * List failed rows with their file's location; with apply, move each existing file back into
 * importing/ and reset its row to pending. Rows without a file stay failed.
 * The file moves first: if the row update then fails, the next run finds it in importing/.
 * @param {ReturnType<typeof openStore>} store
 * @param {string} stagingDir
 * @param {{ apply: boolean }} options
 * @returns {Promise<Array<{ id: string, size: number, location: 'failed'|'importing'|'missing',
 *   result: null|'requeued'|'skipped'|'error', error?: string }>>}
 */
export async function requeueFailed(store, stagingDir, { apply }) {
  const items = [];
  for (const row of store.listFailed()) {
    const location = await locate(stagingDir, row.id);
    const item = { id: row.id, size: row.size, location, result: null };
    if (apply && item.location !== 'missing') {
      try {
        if (item.location === 'failed') {
          const importDir = path.join(stagingDir, IMPORT_DIR_NAME);
          await fs.mkdir(importDir, { recursive: true });
          await fs.rename(
            path.join(stagingDir, FAILED_DIR_NAME, row.id),
            path.join(importDir, row.id),
          );
        }
        // false: the row is no longer failed (changed meanwhile); nothing to do.
        item.result = store.requeue(row.id) ? 'requeued' : 'skipped';
      } catch (err) {
        item.result = 'error';
        item.error = err.message;
      }
    }
    items.push(item);
  }
  return items;
}

/** @param {Awaited<ReturnType<typeof requeueFailed>>} items */
export function formatRequeue(items, { apply }) {
  if (items.length === 0) return ['取り込みに失敗したファイルはありません'];
  const count = (key, value) => items.filter((i) => i[key] === value).length;
  const bytes = items.reduce((sum, i) => sum + i.size, 0);
  const lines = [
    `取り込みに失敗: ${items.length}件 (${formatBytes(bytes)})`,
    ...Object.entries(LOCATION_LABELS).map(
      ([key, label]) => `  ${label}: ${count('location', key)}件`,
    ),
  ];
  for (const item of items) {
    const result = item.result ? ` → ${item.result}${item.error ? ` (${item.error})` : ''}` : '';
    lines.push(`  ${item.id}  ${LOCATION_LABELS[item.location]}${result}`);
  }
  const recoverable = items.length - count('location', 'missing');
  if (apply) {
    lines.push(`取り込み待ちに戻した: ${count('result', 'requeued')}件`);
    if (count('result', 'error') > 0) {
      lines.push(`⚠️ 戻せなかった: ${count('result', 'error')}件(もう一度実行する)`);
    }
    if (count('result', 'requeued') > 0) {
      lines.push('窓口を作り直す(再起動する)と取り込みを再開します');
    }
  } else if (recoverable > 0) {
    lines.push(
      `戻せるファイル: ${recoverable}件。原因を直してから --apply を付けて実行し、窓口を作り直す(再起動する)`,
    );
  }
  if (count('location', 'missing') > 0) {
    lines.push('ファイルなしの分は戻せないため、失敗のまま残します(本人に送り直してもらう)');
  }
  return lines;
}

/**
 * @param {string[]} argv arguments without node/script
 * @param {Record<string, string|undefined>} env
 * @param {{ log?: (msg: string) => void }} [deps]
 */
export async function runCli(argv, env, { log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { apply: { type: 'boolean', default: false } },
  });
  if (!env.DB_PATH || !env.STAGING_DIR) {
    throw new Error(
      'DB_PATH and STAGING_DIR must be set (run it inside the gateway container: docker exec guest_gateway node scripts/requeue-failed.js)',
    );
  }
  // Read-only unless applying; never create a database that does not exist yet.
  await fs.access(env.DB_PATH).catch((err) => {
    throw new Error(`cannot open ${env.DB_PATH} (no uploads recorded yet?): ${err.message}`, {
      cause: err,
    });
  });
  const store = openStore(env.DB_PATH, { readOnly: !values.apply });
  try {
    const items = await requeueFailed(store, env.STAGING_DIR, { apply: values.apply });
    log(formatRequeue(items, { apply: values.apply }).join('\n'));
    return items;
  } finally {
    store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2), process.env).catch((err) => {
    console.error(`[guest-gateway] requeue failed: ${err.message}`);
    process.exit(1);
  });
}
