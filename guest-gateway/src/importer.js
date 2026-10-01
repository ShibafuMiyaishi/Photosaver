// guest-gateway/src/importer.js
// 取り込みキュー: 受信済みファイルを共有リンク経由で Immich に送り(アルバムへは Immich が自動追加)、
// 結果を記録してステージングのファイルを消す。Immich の一時的な不調では間隔を空けて再試行し、
// ファイル自体が原因の拒否では失敗として確定する。状態は store にあるので再起動しても再開できる。

import fs from 'node:fs/promises';
import path from 'node:path';
import { ImmichError } from './immich.js';
import { log } from './log.js';

// Immich rejected the file itself; re-sending the same bytes cannot succeed.
const PERMANENT_STATUSES = new Set([400, 413, 415, 422]);
// Network errors, 5xx, 429 and 401/403/404 (key, link or album misconfigured: fixable by the
// admin, then picked up again) are retried with these delays; the last one repeats.
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
// About 1.5 hours of retries with the default delays.
const DEFAULT_MAX_ATTEMPTS = 20;
// tus ids are random hex; anything else must never be joined into a path.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @param {{
 *   store: ReturnType<import('./store.js').openStore>,
 *   immich: ReturnType<import('./immich.js').createImmichClient>,
 *   dir: string,
 *   concurrency?: number,
 *   retryDelaysMs?: number[],
 *   maxAttempts?: number,
 * }} options
 */
export function createImporter({
  store,
  immich,
  dir,
  concurrency = 2,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const queue = [];
  // Every id that is queued, running or waiting for a retry: enqueue() ignores these.
  const tracked = new Set();
  const retryTimers = new Set();
  const idleWaiters = [];
  const stopController = new AbortController();
  let running = 0;

  const filePathOf = (uploadId) => path.join(dir, uploadId);

  function notifyIfIdle() {
    if (running > 0 || queue.length > 0 || retryTimers.size > 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  async function discard(uploadId) {
    await fs.rm(filePathOf(uploadId), { force: true }).catch((err) => {
      log('error', 'import_staging_remove_failed', { id: uploadId, error: err.message });
    });
  }

  function scheduleRetry(uploadId, attempts) {
    const delay = retryDelaysMs[Math.min(attempts - 1, retryDelaysMs.length - 1)];
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      queue.push(uploadId);
      pump();
    }, delay);
    retryTimers.add(timer);
  }

  /** @returns {Promise<'done'|'retry'>} */
  async function importOne(uploadId) {
    const row = store.get(uploadId);
    if (!row || row.status !== 'pending') return 'done';
    const filePath = filePathOf(uploadId);
    if (!(await fs.stat(filePath).catch(() => null))?.isFile()) {
      store.markFailed(uploadId);
      log('error', 'import_file_missing', { id: uploadId });
      return 'done';
    }

    const attempts = store.addAttempt(uploadId);
    try {
      const result = await immich.uploadAsset({
        filePath,
        filename: row.filename,
        mime: row.mime,
        lastModified: row.last_modified,
        signal: stopController.signal,
      });
      store.markImported(uploadId, result.status, result.id);
      log('info', 'import_done', { id: uploadId, status: result.status, attempts });
      await discard(uploadId);
      return 'done';
    } catch (err) {
      // Shutting down: leave the row pending; the next start resumes it.
      if (stopController.signal.aborted) return 'done';
      const status = err instanceof ImmichError ? err.status : 0;
      if (!(err instanceof ImmichError)) {
        log('error', 'import_unexpected_error', { id: uploadId, error: err?.message });
      }
      if (PERMANENT_STATUSES.has(status) || attempts >= maxAttempts) {
        store.markFailed(uploadId);
        log('error', 'import_failed', { id: uploadId, status, attempts });
        await discard(uploadId);
        return 'done';
      }
      log('warn', 'import_retry', { id: uploadId, status, attempts });
      scheduleRetry(uploadId, attempts);
      return 'retry';
    }
  }

  function pump() {
    while (!stopController.signal.aborted && running < concurrency && queue.length > 0) {
      const uploadId = queue.shift();
      running += 1;
      importOne(uploadId)
        .catch((err) => {
          // store (sqlite) errors: keep the row pending so a restart retries it.
          log('error', 'import_crashed', { id: uploadId, error: err?.message });
          return 'done';
        })
        .then((outcome) => {
          running -= 1;
          // Ids waiting for a retry stay tracked so enqueue() cannot double-queue them.
          if (outcome !== 'retry') tracked.delete(uploadId);
          pump();
        });
    }
    notifyIfIdle();
  }

  return {
    /** Queue a received file (its row must already be in the store). */
    enqueue(uploadId) {
      if (!SAFE_ID.test(uploadId) || tracked.has(uploadId) || stopController.signal.aborted) {
        return;
      }
      tracked.add(uploadId);
      queue.push(uploadId);
      pump();
    },

    /** Re-queue everything still pending (call once at startup). */
    resume() {
      const rows = store.listPending();
      for (const row of rows) this.enqueue(row.upload_id);
      return rows.length;
    },

    /** Files waiting for Immich (queued, running or waiting for a retry). */
    get size() {
      return queue.length + running + retryTimers.size;
    },

    /** Resolves once nothing is queued, running or waiting for a retry. */
    idle() {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        notifyIfIdle();
      });
    },

    /** Abort in-flight uploads and drop timers; pending rows stay pending for the next start. */
    stop() {
      stopController.abort();
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      queue.length = 0;
    },
  };
}
