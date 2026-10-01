// guest-gateway/src/lockout.js
// 合言葉ログインの総当たり対策。IP(IPv6 は /64 単位)ごとの段階的ロックと、全体の一時停止(メモリ上)。

import net from 'node:net';
import { log } from './log.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const LOCKOUT_DEFAULTS = {
  windowMs: 15 * MINUTE_MS,
  maxFailures: 5,
  baseLockMs: 15 * MINUTE_MS,
  maxLockMs: 24 * HOUR_MS,
  levelResetMs: 24 * HOUR_MS,
  globalMaxFailures: 100,
  globalPauseMs: 5 * MINUTE_MS,
  maxKeys: 10_000,
  pruneIntervalMs: MINUTE_MS,
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
  let globalFailures = [];
  let globalPausedUntil = 0;
  let lastPrune = 0;

  const isExpired = (entry, t) => {
    if (entry.lockedUntil > t) return false;
    const idleMs = t - entry.lastFailure;
    return entry.level > 0 ? idleMs >= opts.levelResetMs : idleMs >= opts.windowMs;
  };

  const prune = (t) => {
    if (t - lastPrune < opts.pruneIntervalMs) return;
    lastPrune = t;
    for (const [key, entry] of entries) {
      if (isExpired(entry, t)) entries.delete(key);
    }
  };

  const trimWindow = (list, t) => list.filter((ts) => t - ts < opts.windowMs);

  /** Whether a login attempt from this address may run the password check at all. */
  function check(ip) {
    const t = now();
    prune(t);
    if (globalPausedUntil > t) return { allowed: false, retryAfterMs: globalPausedUntil - t };
    const entry = entries.get(clientKey(ip));
    if (entry && entry.lockedUntil > t) {
      return { allowed: false, retryAfterMs: entry.lockedUntil - t };
    }
    return { allowed: true, retryAfterMs: 0 };
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

  /** A correct password clears the failure count (the lock level is kept). */
  function recordSuccess(ip) {
    const entry = entries.get(clientKey(ip));
    if (entry) entry.failures = [];
  }

  return { check, recordFailure, recordSuccess, size: () => entries.size };
}
