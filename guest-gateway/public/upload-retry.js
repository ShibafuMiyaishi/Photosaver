// guest-gateway/public/upload-retry.js
// アップロード失敗の分類と自動再試行の間隔(DOM に触れない純粋な関数。app.js から使い、単体テストもする)。
// 一時的な失敗(通信エラー・5xx・429 など)は自動でやり直し、直らない失敗(容量超過・形式違いなど)は
// やり直さない。401 はログインし直すまで待つ(自動再試行しても同じ 401 になるだけ)。
// 端末側でファイルが読めなくなった場合(iOS がタブを止めている間に一時ファイルが消えた等)も
// やり直さず、選び直してもらう。

// Pause between automatic re-queues of one failed item while the page stays visible (capped),
// on top of tus' own RETRY_DELAYS inside each attempt.
export const AUTO_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
// After this many automatic re-queues the item waits for the 「再試行」 button (or for the page
// to become visible again / the network to come back, which start a fresh round).
export const MAX_AUTO_RETRIES = 10;
// ± share of the delay: guests at one venue hit by the same outage do not all return at once.
const JITTER = 0.2;

// Statuses (besides network errors and 5xx) that a later attempt can succeed with:
// 408 timeout, 409/423 tus offset/lock conflicts, 429 busy.
const TRANSIENT_4XX = new Set([408, 409, 423, 429]);

/**
 * Failures that re-sending the same file cannot fix: 507 (server disk full — needs the
 * organiser) and 4xx such as 413 (too large) / 415 (not a photo or video) / 400 / 403 / 404.
 * Not permanent: network errors (no status), 5xx (e.g. 503 = HDD not mounted), 401 (re-login),
 * the transient 4xx above. 410 (closed) is handled by the caller before this.
 * @param {number|undefined} status HTTP status of the failed request (undefined = network error)
 */
export function isPermanentFailure(status) {
  if (status === 507) return true;
  if (!status || status < 400 || status >= 500) return false;
  return status !== 401 && !TRANSIENT_4XX.has(status);
}

/**
 * Failures a later attempt can fix: network errors, 5xx except 507, 408/409/423/429.
 * Used as tus-js-client `onShouldRetry` (its default rules plus 408/429, and — unlike the
 * default — it keeps retrying while `navigator.onLine` is false, so a short Wi-Fi blip is
 * covered by retryDelays instead of failing the item at once) and to decide whether the page
 * re-queues a failed item by itself. 401 is neither: the guest has to log in again first.
 * @param {number|undefined} status
 */
export function isTransientFailure(status) {
  return status !== 401 && !isPermanentFailure(status);
}

/**
 * Delay before automatic re-queue number `attempt` (0-based), with jitter.
 * @param {number} attempt
 * @param {() => number} [random] Math.random-compatible source (tests pass a fixed one)
 */
export function autoRetryDelay(attempt, random = Math.random) {
  const base = AUTO_RETRY_DELAYS_MS[Math.min(attempt, AUTO_RETRY_DELAYS_MS.length - 1)];
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
}

// DOMException names for a File whose data the browser can no longer read (e.g. iOS dropped the
// picker's temporary copy while the tab was suspended, or the file was changed or deleted).
const UNREADABLE_FILE_ERRORS = new Set(['NotReadableError', 'NotFoundError']);

/**
 * True when `err` (or an error it wraps as tus' `causingError`) says the file cannot be read.
 * @param {unknown} err
 */
export function isUnreadableFileError(err) {
  let current = err;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (UNREADABLE_FILE_ERRORS.has(current.name)) return true;
    current = current.causingError;
  }
  return false;
}

/**
 * What to do about a failed tus upload.
 * - 'closed': 410, the event is over.
 * - 'unreadable': the file itself cannot be read any more; re-sending cannot help, the guest has
 *   to pick it again. tus-js-client 4.x emits errors that did not come from an HTTP request
 *   without `originalRequest` (and never retries those itself). In browsers it reads the file
 *   lazily inside `XMLHttpRequest.send(blob)`, so a read failure there looks like a network error
 *   (request, no response): the caller probes the file (`canReadFile`) and passes the result.
 * - 'permanent' / 'login' / 'transient': see isPermanentFailure / isTransientFailure.
 * @param {{ originalRequest?: unknown, originalResponse?: { getStatus?: () => number } | null }} err
 * @param {{ fileReadable?: boolean }} [probe] result of canReadFile (true when not probed)
 * @returns {{ kind: 'closed'|'unreadable'|'permanent'|'login'|'transient', status: number|undefined }}
 */
export function classifyUploadError(err, { fileReadable = true } = {}) {
  const status = err?.originalResponse?.getStatus?.() || undefined;
  if (status === 410) return { kind: 'closed', status };
  if (!fileReadable || isUnreadableFileError(err) || (err?.originalRequest == null && !status)) {
    return { kind: 'unreadable', status };
  }
  if (isPermanentFailure(status)) return { kind: 'permanent', status };
  if (status === 401) return { kind: 'login', status };
  return { kind: 'transient', status };
}

/**
 * Whether the browser can still read the file: reads its first byte. Any failure counts as
 * unreadable (NotReadableError / NotFoundError in practice).
 * @param {{ slice: (start: number, end: number) => { arrayBuffer: () => Promise<ArrayBuffer> } }} file
 */
export async function canReadFile(file) {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * Key that identifies "the same file picked again" (same as the tus fingerprint).
 * @param {{ name: string, size: number, lastModified: number }} file
 */
export function fileKey(file) {
  return [file.name, file.size, file.lastModified].join(':');
}

// After this many status answers in a row that do not mention an upload, the page stops asking
// (e.g. a row the server no longer reports) and shows a neutral "received" text instead.
export const MAX_STATUS_MISSES = 5;

/**
 * Count status answers that left an upload out. Returns the new miss count and whether to give up.
 * @param {number} misses previous count
 * @param {boolean} listed the upload was in this answer
 */
export function nextStatusMisses(misses, listed) {
  const next = listed ? 0 : misses + 1;
  return { misses: next, giveUp: next >= MAX_STATUS_MISSES };
}
