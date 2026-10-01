// guest-gateway/src/store.js
// 取り込み状態の記録(node:sqlite)。1 行 = 受信済みの 1 ファイル。
// 誰の端末から上がったか(deviceId・ニックネーム)と Immich の assetId を残し、
// 状態表示・再起動後の取り込み再開・(次の段階で)削除権限の判定に使う。

import { DatabaseSync } from 'node:sqlite';

// pending: waiting for / retrying the Immich upload. created / duplicate: in the album.
// failed: given up (the staged file is gone).
export const STATUSES = ['pending', 'created', 'duplicate', 'failed'];
const UPLOADER_CHUNK = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS uploads (
  upload_id     TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  last_modified INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending',
  asset_id      TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_device ON uploads (device_id, created_at);
CREATE INDEX IF NOT EXISTS uploads_status ON uploads (status);
CREATE INDEX IF NOT EXISTS uploads_asset ON uploads (asset_id);
`;

/**
 * @param {string} dbPath file path, or ':memory:' in tests
 */
export function openStore(dbPath, { now = Date.now } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO uploads
      (upload_id, device_id, nickname, filename, mime, size, last_modified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getOne = db.prepare('SELECT * FROM uploads WHERE upload_id = ?');
  const setDone = db.prepare(
    'UPDATE uploads SET status = ?, asset_id = ?, updated_at = ? WHERE upload_id = ?',
  );
  const setFailed = db.prepare(
    "UPDATE uploads SET status = 'failed', updated_at = ? WHERE upload_id = ?",
  );
  const bumpAttempts = db.prepare(
    'UPDATE uploads SET attempts = attempts + 1, updated_at = ? WHERE upload_id = ? RETURNING attempts',
  );
  const byDeviceAndIds = (count) =>
    db.prepare(`
      SELECT upload_id, filename, status FROM uploads
      WHERE device_id = ? AND upload_id IN (${Array(count).fill('?').join(', ')})`);
  const byDevice = db.prepare(`
    SELECT upload_id, filename, status, created_at FROM uploads
    WHERE device_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`);
  // Uploader per asset: the first guest whose upload created it (duplicates point to the same
  // asset but do not make it theirs).
  const uploaderSql = (count) => `
      SELECT asset_id, nickname, device_id FROM uploads
      WHERE status = 'created' AND asset_id IN (${Array(count).fill('?').join(', ')})
      ORDER BY created_at, rowid`;
  // Full chunks reuse one prepared statement; only the last, shorter chunk is prepared ad hoc.
  const uploaderFullChunk = db.prepare(uploaderSql(UPLOADER_CHUNK));
  const uploaderOf = (count) =>
    count === UPLOADER_CHUNK ? uploaderFullChunk : db.prepare(uploaderSql(count));
  const pending = db.prepare(
    "SELECT * FROM uploads WHERE status = 'pending' ORDER BY created_at, rowid",
  );

  return {
    /**
     * Record a received file. Re-recording the same tus id is a no-op (finish hook retries).
     * @param {{ uploadId: string, deviceId: string, nickname: string, filename: string,
     *   mime: string, size: number, lastModified: number|null }} row
     */
    add(row) {
      const t = now();
      insert.run(
        row.uploadId,
        row.deviceId,
        row.nickname,
        row.filename,
        row.mime,
        row.size,
        row.lastModified,
        t,
        t,
      );
    },

    get(uploadId) {
      return getOne.get(uploadId);
    },

    /** @param {'created'|'duplicate'} status */
    markImported(uploadId, status, assetId) {
      setDone.run(status, assetId, now(), uploadId);
    },

    markFailed(uploadId) {
      setFailed.run(now(), uploadId);
    },

    /** Count one Immich attempt; returns the new total. */
    addAttempt(uploadId) {
      return bumpAttempts.get(now(), uploadId)?.attempts ?? 0;
    },

    /** The caller's own uploads, newest first (never other devices' rows). */
    listForDevice(deviceId, limit = 500) {
      return byDevice.all(deviceId, limit).map((r) => ({
        id: r.upload_id,
        filename: r.filename,
        status: r.status,
      }));
    },

    /** Status of specific uploads, restricted to the caller's device (unknown ids are skipped). */
    statusForDevice(deviceId, uploadIds) {
      if (uploadIds.length === 0) return [];
      return byDeviceAndIds(uploadIds.length)
        .all(deviceId, ...uploadIds)
        .map((r) => ({ id: r.upload_id, filename: r.filename, status: r.status }));
    },

    /**
     * Who uploaded these assets through the gateway: Map assetId → { nickname, deviceId }.
     * Assets added another way (e.g. the Immich app) are absent.
     */
    uploaders(assetIds) {
      const result = new Map();
      // Chunked: a whole album can hold thousands of ids.
      for (let i = 0; i < assetIds.length; i += UPLOADER_CHUNK) {
        const chunk = assetIds.slice(i, i + UPLOADER_CHUNK);
        for (const row of uploaderOf(chunk.length).all(...chunk)) {
          if (result.has(row.asset_id)) continue;
          result.set(row.asset_id, { nickname: row.nickname, deviceId: row.device_id });
        }
      }
      return result;
    },

    /** Rows still waiting for Immich, oldest first (resumed after a restart). */
    listPending() {
      return pending.all();
    },

    close() {
      db.close();
    },
  };
}
