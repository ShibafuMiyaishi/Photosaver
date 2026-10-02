// guest-gateway/src/index.js
// 起動エントリ。設定検証 → HDD マーカー・ステージング先の確認 → (取り込みモードなら)記録 DB と
// 取り込みキューの準備・未完了分の再開 → 受信し終えたのに完了処理前に止まったファイルの拾い直し →
// HTTP 待ち受け → 定期処理(期限切れの掃除)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createImmichClient } from './immich.js';
import { createImporter } from './importer.js';
import { log } from './log.js';
import { openStore } from './store.js';
import { FAILED_DIR_NAME, IMPORT_DIR_NAME, mountMarkerPresent, purgeStaging } from './uploads.js';

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const CLOSE_CHECK_INTERVAL_MS = 60 * 1000;

let config;
try {
  config = loadConfig();
} catch (err) {
  log('error', 'config_invalid', { error: err.message });
  process.exit(1);
}

// The marker file only exists on the mounted photo HDD (see docs/new-server-setup.md).
if (!(await mountMarkerPresent(config.mountMarker))) {
  log('error', 'mount_marker_missing', { marker: config.mountMarker });
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

let store;
let importer;
let immich;
if (config.immich) {
  try {
    store = openStore(config.immich.dbPath);
  } catch (err) {
    log('error', 'db_unavailable', { error: err.message });
    process.exit(1);
  }
  immich = createImmichClient({
    baseUrl: config.immich.baseUrl,
    shareKey: config.immich.shareKey,
    deleteApiKey: config.immich.deleteApiKey,
  });
  importer = createImporter({
    store,
    immich,
    dir: path.join(config.stagingDir, IMPORT_DIR_NAME),
    failedDir: path.join(config.stagingDir, FAILED_DIR_NAME),
  });
  log('info', 'import_resumed', { count: importer.resume() });
  // Not fatal: Immich may still be starting; failed imports are retried anyway.
  Promise.all([immich.serverVersion(), immich.getAlbum(config.immich.albumId)])
    .then(([version, album]) =>
      log('info', 'immich_ok', {
        version: `${version.major}.${version.minor}.${version.patch}`,
        assets: album.assetCount,
      }),
    )
    .catch((err) => log('warn', 'immich_unreachable', { error: err.message }));
} else {
  log('warn', 'speed_test_mode', { reason: 'IMMICH_SHARE_KEY is not set; nothing is imported' });
}

const { app, tusServer, isClosed } = createApp(config, { store, importer, immich });

// Before accepting requests: finish uploads whose last bytes arrived but whose finish step
// (move + record) never ran because the process stopped in between.
try {
  log('info', 'staging_reconcile_done', { repaired: await tusServer.reconcile() });
} catch (err) {
  // Not fatal: the affected uploads stay in staging and the next start tries again.
  log('error', 'staging_reconcile_failed', { error: err.message });
}

const server = app.listen(config.port, config.host, () => {
  log('info', 'listening', {
    host: config.host,
    port: config.port,
    closesAt: new Date(config.closesAt).toISOString(),
    importing: Boolean(importer),
    keepUploads: config.keepUploads,
  });
});
// Large uploads arrive as 50 MB tus chunks; keep a generous per-request timeout.
server.requestTimeout = 30 * 60 * 1000;
// Every request comes through tailscaled's serve proxy, which reuses idle upstream connections
// for up to 90 s (Go http.Transport IdleConnTimeout in ipn/ipnlocal/serve.go). Node's default
// 5 s keep-alive would close them under it, and a request sent on a connection we are closing
// (e.g. a tus PATCH, whose body the proxy cannot replay) fails as a 502. So outlast the proxy;
// headersTimeout must exceed keepAliveTimeout and stay <= requestTimeout.
server.keepAliveTimeout = 95_000;
server.headersTimeout = 96_000;

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
  // Files still waiting for Immich stay; the importer removes each one when it is done.
  // failed/ is never purged (see purgeStaging).
  purgeStaging(config.stagingDir, { keep: importer ? [IMPORT_DIR_NAME] : [] })
    .then((count) => log('info', 'closed_staging_purged', { count }))
    .catch((err) => log('error', 'purge_failed', { error: err.message }));
}, CLOSE_CHECK_INTERVAL_MS);

function shutdown(signal) {
  log('info', 'shutdown', { signal });
  clearInterval(cleanupTimer);
  clearInterval(closeTimer);
  // Pending imports stay pending in the DB and resume on the next start.
  importer?.stop();
  server.close(() => {
    store?.close();
    process.exit(0);
  });
  // In-flight uploads are resumable, so do not wait forever.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
