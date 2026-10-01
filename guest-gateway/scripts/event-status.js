// guest-gateway/scripts/event-status.js
// 当日の状況確認: 取り込みの記録(DB)を読み取り専用で開き、件数・容量・受付期限までの残り時間・
// HDD の空きを表示する。ニックネームやファイル名は出さない(画面共有・報告にそのまま使える)。
// 動いている窓口コンテナの中で実行する(DB_PATH・CLOSES_AT・STAGING_DIR はコンテナの環境変数):
//   docker exec guest_gateway node scripts/event-status.js

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { openStore } from '../src/store.js';

// A pending row older than this means imports are stuck (normally done within seconds).
export const STUCK_PENDING_MS = 10 * 60_000;

const LABELS = {
  created: '取り込み済み',
  duplicate: '重複(既にアルバムにあった)',
  pending: '取り込み待ち',
  failed: '失敗',
  trashed: 'ゴミ箱の写真と重複',
};

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms) {
  if (ms < 60_000) return '1分未満';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${minutes % 60}分`;
}

/**
 * @param {ReturnType<ReturnType<typeof openStore>['stats']>} stats
 * @param {{ now: number, closesAt: number|null, freeBytes: number|null }} context
 * @returns {{ lines: string[], warnings: string[] }}
 */
export function formatStatus(stats, { now, closesAt, freeBytes }) {
  const lines = [];
  if (closesAt !== null) {
    lines.push(
      closesAt > now
        ? `受付期限まで: あと${formatDuration(closesAt - now)}`
        : '受付期限: 終了済み(ログイン・アップロード・閲覧は停止中)',
    );
  }
  for (const [status, label] of Object.entries(LABELS)) {
    const { count, bytes } = stats.byStatus[status];
    lines.push(`${label}: ${count}件 (${formatBytes(bytes)})`);
  }
  lines.push(`投稿した端末: ${stats.devices}台`);
  lines.push(`窓口から削除: ${stats.deleted}件`);
  if (freeBytes !== null) lines.push(`HDD の空き: ${formatBytes(freeBytes)}`);

  const warnings = [];
  if (stats.oldestPendingAt !== null && now - stats.oldestPendingAt > STUCK_PENDING_MS) {
    warnings.push(
      `取り込み待ちが${formatDuration(now - stats.oldestPendingAt)}以上残っています。` +
        'Immich が止まっていないか確認してください(ログの import_retry)',
    );
  }
  if (stats.byStatus.failed.count > 0) {
    warnings.push(
      '取り込みに失敗したファイルがあります(受信したファイルは削除済み)。ログの import_failed を確認してください',
    );
  }
  return { lines, warnings };
}

async function main(env) {
  if (!env.DB_PATH) {
    throw new Error(
      'DB_PATH is not set (run it inside the gateway container: docker exec guest_gateway node scripts/event-status.js)',
    );
  }
  let store;
  try {
    store = openStore(env.DB_PATH, { readOnly: true });
  } catch (err) {
    throw new Error(`cannot open ${env.DB_PATH} (no uploads recorded yet?): ${err.message}`, {
      cause: err,
    });
  }
  let stats;
  try {
    stats = store.stats();
  } finally {
    store.close();
  }
  const closesAt = env.CLOSES_AT ? Date.parse(env.CLOSES_AT) : NaN;
  let freeBytes = null;
  if (env.STAGING_DIR) {
    const fsStats = await fs.statfs(env.STAGING_DIR).catch(() => null);
    if (fsStats) freeBytes = fsStats.bavail * fsStats.bsize;
  }
  const { lines, warnings } = formatStatus(stats, {
    now: Date.now(),
    closesAt: Number.isFinite(closesAt) ? closesAt : null,
    freeBytes,
  });
  console.log(lines.join('\n'));
  for (const warning of warnings) console.log(`⚠️ ${warning}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.env).catch((err) => {
    console.error(`[guest-gateway] status failed: ${err.message}`);
    process.exit(1);
  });
}
