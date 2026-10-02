// guest-gateway/src/store.js
// 取り込み状態の記録(node:sqlite)。1 行 = 受信済みの 1 ファイル。
// 誰の端末から上がったか(deviceId・ニックネーム)と Immich の assetId を残し、
// 状態表示・再起動後の取り込み再開・削除権限の判定(本人の投稿か)に使う。

import { DatabaseSync } from 'node:sqlite';

// pending: waiting for / retrying the Immich upload. created / duplicate: in the album.
// failed: given up; the staged file was moved to failed/ in the staging dir (or, if that move
// failed, left in importing/). scripts/requeue-failed.js turns it back into pending.
// trashed: re-uploaded while the asset sat in Immich's trash after a delete here; Immich matches
// the trashed copy (verified on v3.2.4) and does not put it back in the album.
// Deleting an asset does not change the status: `deleted_at` marks it instead, so ownership and
// attribution come back on their own if the organiser restores it from the trash in Immich.
// in_flight: an Immich attempt has started and not ended (still 1 after a crash mid-upload).
// ambiguous: an earlier attempt may have reached Immich without us learning the result (network
// error, timeout, abort, 5xx, crash): a later `duplicate` may then be our own asset (see importer).
// reclaimed: `created` was inferred from such a `duplicate`, not reported by Immich. If another row
// later gets a genuine `created` for the same asset, the guess was wrong and the row becomes a
// `duplicate` again (markImported).
export const STATUSES = ['pending', 'created', 'duplicate', 'failed', 'trashed'];
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
  deleted_at    INTEGER,
  ambiguous     INTEGER NOT NULL DEFAULT 0,
  in_flight     INTEGER NOT NULL DEFAULT 0,
  reclaimed     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_device ON uploads (device_id, created_at);
CREATE INDEX IF NOT EXISTS uploads_status ON uploads (status);
CREATE INDEX IF NOT EXISTS uploads_asset ON uploads (asset_id);
`;
// Columns added after the first schema, with their definitions (fixed strings, never input).
const ADDED_COLUMNS = [
  ['deleted_at', 'INTEGER'],
  ['ambiguous', 'INTEGER NOT NULL DEFAULT 0'],
  ['in_flight', 'INTEGER NOT NULL DEFAULT 0'],
  ['reclaimed', 'INTEGER NOT NULL DEFAULT 0'],
];

/**
 * @param {string} dbPath file path, or ':memory:' in tests
 * @param {{ now?: () => number, readOnly?: boolean }} [options] readOnly: for the operator's
 *   status script next to the running gateway (no schema changes, writes fail)
 */
export function openStore(dbPath, { now = Date.now, readOnly = false } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000;');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    // Databases created before these columns existed (CREATE TABLE IF NOT EXISTS keeps them).
    const columns = db
      .prepare('PRAGMA table_info(uploads)')
      .all()
      .map((c) => c.name);
    for (const [name, definition] of ADDED_COLUMNS) {
      if (!columns.includes(name)) db.exec(`ALTER TABLE uploads ADD COLUMN ${name} ${definition}`);
    }
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO uploads
      (upload_id, device_id, nickname, filename, mime, size, last_modified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getOne = db.prepare('SELECT * FROM uploads WHERE upload_id = ?');
  const setDone = db.prepare(
    'UPDATE uploads SET status = ?, asset_id = ?, reclaimed = ?, in_flight = 0, updated_at = ? WHERE upload_id = ?',
  );
  // Rows that only guessed they created this asset (reclaimed) lose it to the real creator.
  const revertReclaimed = db.prepare(`
    UPDATE uploads SET status = 'duplicate', reclaimed = 0, updated_at = ?
    WHERE asset_id = ? AND status = 'created' AND reclaimed = 1 AND upload_id != ?
    RETURNING upload_id`);
  const setFailed = db.prepare(
    "UPDATE uploads SET status = 'failed', in_flight = 0, updated_at = ? WHERE upload_id = ?",
  );
  const setAttemptEnded = db.prepare(
    'UPDATE uploads SET in_flight = 0, ambiguous = MAX(ambiguous, ?), updated_at = ? WHERE upload_id = ?',
  );
  // Only a failed row: never resets one the importer already finished.
  const setRequeued = db.prepare(
    "UPDATE uploads SET status = 'pending', attempts = 0, updated_at = ? WHERE upload_id = ? AND status = 'failed'",
  );
  const failedRows = db.prepare(
    "SELECT upload_id, size, attempts, updated_at FROM uploads WHERE status = 'failed' ORDER BY updated_at, rowid",
  );
  // An attempt still open from before (crash mid-upload) turns into ambiguity first.
  const bumpAttempts = db.prepare(`
    UPDATE uploads SET attempts = attempts + 1, ambiguous = MAX(ambiguous, in_flight),
      in_flight = 1, updated_at = ?
    WHERE upload_id = ? RETURNING attempts`);
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
  const anyCreated = db.prepare(
    "SELECT 1 FROM uploads WHERE asset_id = ? AND status = 'created' LIMIT 1",
  );
  const ownCreated = db.prepare(
    "SELECT 1 FROM uploads WHERE asset_id = ? AND device_id = ? AND status = 'created' LIMIT 1",
  );
  const deletedAsset = db.prepare(
    'SELECT 1 FROM uploads WHERE asset_id = ? AND deleted_at IS NOT NULL LIMIT 1',
  );
  const setDeleted = db.prepare(
    'UPDATE uploads SET deleted_at = ?, updated_at = ? WHERE asset_id = ?',
  );
  const clearDeletedMark = db.prepare(
    'UPDATE uploads SET deleted_at = NULL, updated_at = ? WHERE asset_id = ?',
  );
  const pending = db.prepare(
    "SELECT * FROM uploads WHERE status = 'pending' ORDER BY created_at, rowid",
  );
  const countsByStatus = db.prepare(
    'SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM uploads GROUP BY status',
  );
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT device_id) AS devices,
      COUNT(DISTINCT asset_id) FILTER (WHERE deleted_at IS NOT NULL) AS deleted,
      MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at
    FROM uploads`);

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

    /**
     * Record the import result. reclaimed: `created` inferred from a `duplicate` after an
     * ambiguous attempt. A genuine `created` (Immich said so) turns every reclaimed row for the
     * same asset back into `duplicate`, in the same transaction.
     * @param {'created'|'duplicate'|'trashed'} status
     * @param {{ reclaimed?: boolean }} [options]
     * @returns {string[]} upload ids whose reclaimed `created` was reverted
     */
    markImported(uploadId, status, assetId, { reclaimed = false } = {}) {
      const t = now();
      const isReclaimed = status === 'created' && reclaimed;
      db.exec('BEGIN IMMEDIATE');
      try {
        setDone.run(status, assetId, isReclaimed ? 1 : 0, t, uploadId);
        const reverted =
          status === 'created' && !isReclaimed
            ? revertReclaimed.all(t, assetId, uploadId).map((r) => r.upload_id)
            : [];
        db.exec('COMMIT');
        return reverted;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    markFailed(uploadId) {
      setFailed.run(now(), uploadId);
    },

    /**
     * Back to pending with a fresh attempt budget (the operator moved the file back into
     * importing/). True when the row was failed and is now pending.
     */
    requeue(uploadId) {
      return setRequeued.run(now(), uploadId).changes === 1;
    },

    /** Given-up rows for the operator, oldest first (no nicknames or file names). */
    listFailed() {
      return failedRows.all().map((r) => ({
        id: r.upload_id,
        size: r.size,
        attempts: r.attempts,
        failedAt: r.updated_at,
      }));
    },

    /** Count one Immich attempt and mark it in flight; returns the new total. */
    addAttempt(uploadId) {
      return bumpAttempts.get(now(), uploadId)?.attempts ?? 0;
    },

    /**
     * The attempt ended without a result. ambiguous: Immich may have stored the file anyway
     * (sticky: stays set for the row's later attempts).
     */
    endAttempt(uploadId, { ambiguous }) {
      setAttemptEnded.run(ambiguous ? 1 : 0, now(), uploadId);
    },

    /**
     * True when an earlier attempt of this row may have reached Immich unseen: one ended
     * ambiguously, or one was still in flight when the gateway stopped.
     */
    hadAmbiguousAttempt(uploadId) {
      const row = getOne.get(uploadId);
      return Boolean(row && (row.ambiguous || row.in_flight));
    },

    /** True when some upload through the gateway created this asset. */
    isCreatedByAnyone(assetId) {
      return anyCreated.get(assetId) !== undefined;
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

    /**
     * True when this device's upload created the asset. A duplicate upload of someone else's
     * photo does not make it the caller's to delete.
     */
    isOwnAsset(assetId, deviceId) {
      return ownCreated.get(assetId, deviceId) !== undefined;
    },

    /** The asset went to Immich's trash through the gateway. */
    markDeleted(assetId) {
      const t = now();
      setDeleted.run(t, t, assetId);
    },

    /** The organiser restored it in Immich (seen again in the album). */
    clearDeleted(assetId) {
      clearDeletedMark.run(now(), assetId);
    },

    /** True when this asset was deleted through the gateway and not seen restored since. */
    wasDeleted(assetId) {
      return deletedAsset.get(assetId) !== undefined;
    },

    /**
     * Counts for the operator (no nicknames or file names): per status { count, bytes },
     * devices that uploaded, assets deleted through the gateway, and when the oldest pending row arrived.
     */
    stats() {
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, bytes: 0 }]));
      for (const row of countsByStatus.all()) {
        byStatus[row.status] = { count: row.count, bytes: row.bytes };
      }
      const t = totals.get();
      return {
        byStatus,
        devices: t.devices,
        deleted: t.deleted,
        oldestPendingAt: t.oldest_pending_at ?? null,
      };
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
