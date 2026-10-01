// guest-gateway/src/index.js
// 起動エントリ。設定検証 → ステージング先の確認 → HTTP 待ち受け → 定期処理(期限切れの掃除)。

import fs from 'node:fs/promises';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { purgeStaging } from './uploads.js';

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const CLOSE_CHECK_INTERVAL_MS = 60 * 1000;

let config;
try {
  config = loadConfig();
} catch (err) {
  log('error', 'config_invalid', { error: err.message });
  process.exit(1);
}

// Never create the staging dir ourselves: if the photo HDD is not mounted the path is missing,
// and failing here is safer than filling the system disk.
try {
  await fs.access(config.stagingDir, fs.constants.W_OK);
} catch {
  log('error', 'staging_dir_unavailable', { dir: config.stagingDir });
  process.exit(1);
}

const { app, tusServer, isClosed } = createApp(config);

const server = app.listen(config.port, config.host, () => {
  log('info', 'listening', {
    host: config.host,
    port: config.port,
    closesAt: new Date(config.closesAt).toISOString(),
    keepUploads: config.keepUploads,
  });
});
// Large uploads arrive as 50 MB tus chunks; keep a generous per-request timeout.
server.requestTimeout = 30 * 60 * 1000;

const cleanupTimer = setInterval(() => {
  tusServer
    .cleanUpExpiredUploads()
    .then((count) => count > 0 && log('info', 'expired_uploads_removed', { count }))
    .catch((err) => log('error', 'cleanup_failed', { error: err.message }));
}, CLEANUP_INTERVAL_MS);

let purged = false;
const closeTimer = setInterval(() => {
  if (purged || !isClosed()) return;
  purged = true;
  purgeStaging(config.stagingDir)
    .then((count) => log('info', 'closed_staging_purged', { count }))
    .catch((err) => log('error', 'purge_failed', { error: err.message }));
}, CLOSE_CHECK_INTERVAL_MS);

function shutdown(signal) {
  log('info', 'shutdown', { signal });
  clearInterval(cleanupTimer);
  clearInterval(closeTimer);
  server.close(() => process.exit(0));
  // In-flight uploads are resumable, so do not wait forever.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
