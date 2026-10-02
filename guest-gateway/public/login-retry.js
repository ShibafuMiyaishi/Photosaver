// guest-gateway/public/login-retry.js
// ログインが 429 'busy'(サーバーが同じ接続元の合言葉チェックを同時に受け付けない)だったときの
// 自動再試行の間隔(DOM に触れない純粋な関数。app.js から使い、単体テストもする)。
// 会場では大勢が同じ Wi-Fi(1 つの接続元)から一斉に入るので、回数ではなく経過時間で粘る。

// Keep retrying a busy login until this much time has passed since the first attempt…
export const LOGIN_BUSY_MAX_MS = 45_000;
// …but never more than this many retries.
export const LOGIN_BUSY_MAX_RETRIES = 20;
// Jitter on top of Retry-After grows per retry from 1 s up to 3 s, so guests who were turned
// away together spread out instead of all coming back in the same second.
const JITTER_MIN_MS = 1_000;
const JITTER_MAX_MS = 3_000;
const JITTER_STEP_MS = 250;

/**
 * Wait before busy-login retry number `retry` (1-based), or null to stop retrying.
 * @param {{ retry: number, elapsedMs: number, retryAfter?: string | null, random?: () => number }} opts
 *   retry: the retry about to be made; elapsedMs: time since the first attempt;
 *   retryAfter: the response's Retry-After header (seconds; missing/invalid = 1 s);
 *   random: Math.random-compatible source (tests pass a fixed one)
 * @returns {number | null} milliseconds to wait
 */
export function loginBusyDelay({ retry, elapsedMs, retryAfter, random = Math.random }) {
  if (retry > LOGIN_BUSY_MAX_RETRIES || elapsedMs >= LOGIN_BUSY_MAX_MS) return null;
  const retryAfterSec = Number(retryAfter);
  const baseMs = Math.max(Number.isFinite(retryAfterSec) ? retryAfterSec : 0, 1) * 1000;
  const jitterMs = Math.min(JITTER_MIN_MS + (retry - 1) * JITTER_STEP_MS, JITTER_MAX_MS);
  return Math.round(baseMs + random() * jitterMs);
}
