// guest-gateway/src/importer.js
// 取り込みキュー: 受信済みファイルを共有リンク経由で Immich に送り(アルバムへは Immich が自動追加)、
// 結果を記録してステージングのファイルを消す。Immich の一時的な不調では間隔を空けて再試行し、
// Immich が拒否したとき(共有リンクの設定変更でも起きる)や再試行の上限では失敗として確定するが、
// ファイルは消さずに failed/ へ移す(元の写真のバックアップは無いため。scripts/requeue-failed.js で
// 取り込み待ちに戻せる)。状態は store にあるので再起動しても再開できる。
// 結果が分からないまま終わった送信(通信断・時間切れ・停止・5xx)の後の再送が「重複」になったら、
// それは自分の前回の送信が届いていたものとみなし、他に作成者がいなければ「作成」として記録する。
// その推測の後に別の端末の送信が本当に「作成」になったら、推測した行は「重複」に戻す。

import fs from 'node:fs/promises';
import path from 'node:path';
import { ImmichError } from './immich.js';
import { log } from './log.js';

// Immich rejected the request; re-sending the same bytes as-is will not succeed. Not always the
// file's fault (a 400 also comes from a shared link whose upload permission was switched off),
// so the file is set aside in failed/, never deleted.
const PERMANENT_STATUSES = new Set([400, 413, 415, 422]);
// Network errors, 5xx, 429 and 401/403/404 (key, link or album misconfigured: fixable by the
// admin, then picked up again) are retried with these delays; the last one repeats.
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
// About a day of retries with the default delays: giving up needs the operator (requeue from
// failed/), so an Immich outage during the event (or overnight after it) must not run this out.
export const DEFAULT_MAX_ATTEMPTS = 300;
// tus ids are random hex; anything else must never be joined into a path.
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether a failed attempt may still have stored the file in Immich: no response at all
 * (network error, timeout, abort — the body may have been sent), a server error, or a success
 * status whose body we could not read. A 4xx means Immich refused it.
 */
export function isAmbiguousFailure(status) {
  return status === 0 || status >= 500 || (status >= 200 && status < 300);
}

/**
 * dir: importing/ (one file per upload id). failedDir: where given-up files are moved; must be
 * on the same filesystem (a rename, never a copy).
 * @param {{
 *   store: ReturnType<import('./store.js').openStore>,
 *   immich: ReturnType<import('./immich.js').createImmichClient>,
 *   dir: string,
 *   failedDir: string,
 *   concurrency?: number,
 *   retryDelaysMs?: number[],
 *   maxAttempts?: number,
 * }} options
 */
export function createImporter({
  store,
  immich,
  dir,
  failedDir,
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

  /** Keep a given-up file for the operator. If the move fails, it stays in importing/. */
  async function setAside(uploadId) {
    try {
      await fs.mkdir(failedDir, { recursive: true });
      await fs.rename(filePathOf(uploadId), path.join(failedDir, uploadId));
    } catch (err) {
      log('error', 'import_set_aside_failed', { id: uploadId, error: err.message });
    }
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

    // Read before addAttempt, which turns an attempt left open by a crash into ambiguity.
    const ambiguousBefore = store.hadAmbiguousAttempt(uploadId);
    const attempts = store.addAttempt(uploadId);
    try {
      const result = await immich.uploadAsset({
        filePath,
        filename: row.filename,
        mime: row.mime,
        lastModified: row.last_modified,
        signal: stopController.signal,
      });
      // A duplicate of something deleted here is the trashed copy, which stays out of the album —
      // unless the organiser restored it meanwhile.
      let status = result.status;
      let reclaimed = false;
      if (status === 'duplicate' && store.wasDeleted(result.id)) {
        if (await immich.isAssetVisible(result.id)) store.clearDeleted(result.id);
        else status = 'trashed';
      } else if (status === 'duplicate' && ambiguousBefore && !store.isCreatedByAnyone(result.id)) {
        // Most likely our own earlier attempt created it and the answer was lost: credit this
        // device (uploader name, own-delete) as if that attempt had succeeded.
        status = 'created';
        reclaimed = true;
        log('info', 'import_duplicate_reclaimed', { id: uploadId, attempts });
      }
      // A genuine `created` also reverts any row that reclaimed this asset by mistake (another
      // device's request with the same bytes was still on its way when the guess was made).
      const reverted = store.markImported(uploadId, status, result.id, { reclaimed });
      for (const revertedId of reverted) {
        log('warn', 'import_reclaim_reverted', { id: revertedId, createdBy: uploadId });
      }
      log('info', 'import_done', { id: uploadId, status, attempts });
      await discard(uploadId);
      return 'done';
    } catch (err) {
      // Shutting down: leave the row pending; the next start resumes it. The aborted request may
      // already have reached Immich.
      if (stopController.signal.aborted) {
        store.endAttempt(uploadId, { ambiguous: true });
        return 'done';
      }
      const status = err instanceof ImmichError ? err.status : 0;
      if (!(err instanceof ImmichError)) {
        log('error', 'import_unexpected_error', { id: uploadId, error: err?.message });
      }
      store.endAttempt(uploadId, { ambiguous: isAmbiguousFailure(status) });
      if (PERMANENT_STATUSES.has(status) || attempts >= maxAttempts) {
        // Move the file before marking the row failed: requeue-failed.js only picks up failed
        // rows, so it never sees one whose file is still on its way to failed/.
        await setAside(uploadId);
        store.markFailed(uploadId);
        log('error', 'import_failed', { id: uploadId, status, attempts });
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
