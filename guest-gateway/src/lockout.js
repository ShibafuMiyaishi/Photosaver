// guest-gateway/src/lockout.js
// 合言葉ログインの総当たり対策。IP(IPv6 は /64 単位)ごとの段階的ロックと、全体の一時停止(メモリ上)。
// 24 時間以内にログインに成功したアドレス(会場 Wi-Fi など)は「信頼済み」として全体停止の対象外にする。

import net from 'node:net';
import { log } from './log.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Tuned for a venue: many guests share one public IP (venue Wi-Fi, carrier NAT), so honest
// typos from everyone there add up on one key, and a lock hits them all. The shared password
// only opens a guest album; scrypt, one check in flight per key, the doubling lock and the
// global pause still bound guessing (per key roughly 20 tries per hour once the lock is capped).
//
// Trusted keys: a client key with a correct password within `levelResetMs` (24 h) is trusted.
// It bypasses the global pause and its failures do not feed the global window, so an attacker
// who trips the pause from other addresses (a few IPv4s, IPv6 /64 rotation) cannot keep the
// venue — or any guest who already got in once — locked out for the whole event. Trusted keys
// keep the normal per-key counting and doubling lock. Only untrusted keys are paused, which
// still bounds distributed guessing from addresses that never knew the password.
// Trust lives in memory only and is lost on restart: after a restart the organiser should log
// in once from the venue Wi-Fi again (and before guests arrive in the first place).
// maxFailures / baseLockMs can be tuned without code changes (LOGIN_MAX_FAILURES /
// LOGIN_LOCK_MINUTES, see config.js).
export const LOCKOUT_DEFAULTS = {
  windowMs: 15 * MINUTE_MS,
  maxFailures: 20,
  // 2, 4, 8, ... minutes, capped at an hour: a venue that trips it is back in minutes.
  baseLockMs: 2 * MINUTE_MS,
  maxLockMs: HOUR_MS,
  // Also how long a successful login keeps its client key trusted (see above).
  levelResetMs: 24 * HOUR_MS,
  // Pauses logins from all UNTRUSTED keys, so honest traffic should never reach it: even 100+
  // guests arriving within 15 minutes with two typos each stay well below it (the old 100 did
  // not), and failures from trusted keys are not counted at all. A distributed attack from
  // untrusted addresses is still held to about 300 guesses per 15 minutes (the pause re-arms at
  // once while the window is still full).
  globalMaxFailures: 300,
  globalPauseMs: 5 * MINUTE_MS,
  // Cap for failure entries and, separately, for trusted keys (only a correct password adds
  // one, so failures can never push trusted keys out).
  maxKeys: 10_000,
  pruneIntervalMs: MINUTE_MS,
  // scrypt N=2^17 needs ~128 MiB per check (auth.js), and libuv's default pool runs only 4
  // at once anyway (more would just queue): 4 caps login memory at ~0.5 GiB on the 16 GB mini
  // PC shared with Immich and still allows ~13 checks/s on an Apple M3 (4 in ~0.3 s; the mini
  // PC is slower, estimated 5-10/s), plenty for guests arriving over minutes. Extra requests
  // get 429 'busy' (Retry-After: 1) instead of queueing.
  maxConcurrentAttempts: 4,
};

/** Expand an IPv6 address into 8 normalized hextets (no leading zeros). */
function expandIPv6(address) {
  let addr = address.split('%')[0].toLowerCase();
  // Embedded IPv4 tail (e.g. 64:ff9b::1.2.3.4) → two hextets.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr = `${addr.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parts = addr.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  let groups = head;
  if (parts.length === 2) {
    const tail = parts[1] ? parts[1].split(':') : [];
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  }
  return groups.map((g) => parseInt(g, 16).toString(16));
}

/**
 * Lockout key for a client address: IPv4 as-is (IPv4-mapped IPv6 unwrapped),
 * IPv6 grouped by its /64 prefix.
 */
export function clientKey(ip) {
  const raw = String(ip ?? '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  if (net.isIPv4(raw)) return raw;
  const bare = raw.split('%')[0];
  if (net.isIPv6(bare)) return `${expandIPv6(bare).slice(0, 4).join(':')}::/64`;
  return raw || 'unknown';
}

/**
 * @param {Partial<typeof LOCKOUT_DEFAULTS> & { now?: () => number }} [options]
 */
export function createLockout(options = {}) {
  const opts = { ...LOCKOUT_DEFAULTS, ...options };
  const now = options.now ?? Date.now;
  /** @type {Map<string, { failures: number[], level: number, lockedUntil: number, lastFailure: number }>} */
  const entries = new Map();
  // Client keys with a password check in flight. Kept apart from `entries` so pruning and
  // the key cap never drop it; its size is bounded by `maxConcurrentAttempts`.
  const inFlight = new Set();
  // Client key → time of its last successful login (Map order: oldest success first). Kept
  // apart from `entries` so failures from many addresses can never evict a trusted key.
  // In memory only: a restart forgets it (see the comment on trusted keys above).
  /** @type {Map<string, number>} */
  const trusted = new Map();
  let globalFailures = [];
  let globalPausedUntil = 0;
  let lastPrune = 0;

  const isExpired = (entry, t) => {
    if (entry.lockedUntil > t) return false;
    const idleMs = t - entry.lastFailure;
    return entry.level > 0 ? idleMs >= opts.levelResetMs : idleMs >= opts.windowMs;
  };

  const isTrusted = (key, t) => {
    const since = trusted.get(key);
    return since !== undefined && t - since < opts.levelResetMs;
  };

  const prune = (t) => {
    if (t - lastPrune < opts.pruneIntervalMs) return;
    lastPrune = t;
    for (const [key, entry] of entries) {
      if (isExpired(entry, t)) entries.delete(key);
    }
    for (const [key, since] of trusted) {
      // Oldest first: stop at the first one still trusted.
      if (t - since < opts.levelResetMs) break;
      trusted.delete(key);
    }
  };

  const trimWindow = (list, t) => list.filter((ts) => t - ts < opts.windowMs);

  /** Global pause (untrusted keys only) or per-key lock in force for this key, or null. */
  const blockFor = (key, t) => {
    if (globalPausedUntil > t && !isTrusted(key, t)) {
      return { reason: 'paused', retryAfterMs: globalPausedUntil - t };
    }
    const entry = entries.get(key);
    if (entry && entry.lockedUntil > t) {
      return { reason: 'locked', retryAfterMs: entry.lockedUntil - t };
    }
    return null;
  };

  /** Status query (reserves nothing): is this address locked, or paused while untrusted? */
  function check(ip) {
    const t = now();
    prune(t);
    const block = blockFor(clientKey(ip), t);
    if (block) return { allowed: false, retryAfterMs: block.retryAfterMs };
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * Synchronously reserve the right to run one password check. Must be called before any
   * await so concurrent requests cannot all pass the lock check before a failure is recorded.
   * Only one attempt per client key and at most `maxConcurrentAttempts` overall run at once.
   * On success the caller MUST call `release()` exactly when the attempt ends (use finally).
   * @returns {{ ok: true, release: () => void }
   *   | { ok: false, reason: 'locked' | 'paused' | 'busy', retryAfterSec: number }}
   */
  function beginAttempt(ip) {
    const t = now();
    prune(t);
    const key = clientKey(ip);
    const block = blockFor(key, t);
    if (block) {
      const retryAfterSec = Math.ceil(block.retryAfterMs / 1000);
      return { ok: false, reason: block.reason, retryAfterSec };
    }
    if (inFlight.has(key) || inFlight.size >= opts.maxConcurrentAttempts) {
      return { ok: false, reason: 'busy', retryAfterSec: 1 };
    }
    inFlight.add(key);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        inFlight.delete(key);
      },
    };
  }

  function recordFailure(ip) {
    const t = now();
    const key = clientKey(ip);
    let entry = entries.get(key);
    if (entry) {
      // Re-insert so Map order approximates least-recently-failed first.
      entries.delete(key);
      if (t - entry.lastFailure >= opts.levelResetMs) entry.level = 0;
    } else {
      if (entries.size >= opts.maxKeys) entries.delete(entries.keys().next().value);
      entry = { failures: [], level: 0, lockedUntil: 0, lastFailure: 0 };
    }
    entries.set(key, entry);

    entry.failures = trimWindow(entry.failures, t);
    entry.failures.push(t);
    entry.lastFailure = t;
    if (entry.failures.length >= opts.maxFailures) {
      entry.level += 1;
      const lockMs = Math.min(opts.baseLockMs * 2 ** (entry.level - 1), opts.maxLockMs);
      entry.lockedUntil = t + lockMs;
      entry.failures = [];
      log('warn', 'login_locked', { ip: key, lockMinutes: lockMs / MINUTE_MS, level: entry.level });
    }

    // A trusted key (correct password within 24 h) is not part of a distributed guess, and its
    // typos must not pause everyone else either.
    if (isTrusted(key, t)) return;
    globalFailures = trimWindow(globalFailures, t);
    globalFailures.push(t);
    if (globalFailures.length > opts.globalMaxFailures) globalFailures.shift();
    if (globalFailures.length >= opts.globalMaxFailures && globalPausedUntil <= t) {
      globalPausedUntil = t + opts.globalPauseMs;
      log('warn', 'login_global_pause', {
        failures: globalFailures.length,
        pauseMinutes: opts.globalPauseMs / MINUTE_MS,
      });
    }
  }

  /**
   * A correct password clears the failure count (the lock level is kept) and makes the key
   * trusted for `levelResetMs` from now.
   */
  function recordSuccess(ip) {
    const t = now();
    const key = clientKey(ip);
    const entry = entries.get(key);
    if (entry) entry.failures = [];
    // Re-insert so Map order stays oldest success first (pruning and the cap rely on it).
    if (trusted.has(key)) trusted.delete(key);
    else if (trusted.size >= opts.maxKeys) trusted.delete(trusted.keys().next().value);
    trusted.set(key, t);
  }

  return {
    check,
    beginAttempt,
    recordFailure,
    recordSuccess,
    size: () => entries.size,
    trustedSize: () => trusted.size,
    inFlight: () => inFlight.size,
  };
}
