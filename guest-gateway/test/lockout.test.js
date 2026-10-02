// guest-gateway/test/lockout.test.js
// ログイン総当たり対策(IP ごとの段階的ロック・全体停止)を偽の時計で確認する。

import { vi } from 'vitest';
import { clientKey, createLockout } from '../src/lockout.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function setup(options = {}) {
  let t = Date.parse('2026-10-01T00:00:00Z');
  const clock = {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
  return { clock, lockout: createLockout({ now: clock.now, ...options }) };
}

function fail(lockout, ip, times) {
  for (let i = 0; i < times; i += 1) lockout.recordFailure(ip);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('clientKey', () => {
  it('keeps IPv4 and unwraps IPv4-mapped IPv6', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 addresses by /64', () => {
    const a = clientKey('2001:db8:1:2:aaaa::1');
    const b = clientKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(clientKey('2001:db8:1:3::1')).not.toBe(a);
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
  });
});

describe('createLockout', () => {
  it('locks an address on the 20th failure within 15 minutes for 2 minutes', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 19);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
    lockout.recordFailure('203.0.113.7');
    expect(lockout.check('203.0.113.7')).toEqual({ allowed: false, retryAfterMs: 2 * MIN });
    // Other addresses are unaffected.
    expect(lockout.check('198.51.100.1').allowed).toBe(true);
    clock.advance(2 * MIN);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
  });

  it('takes the threshold and first lock from options (LOGIN_MAX_FAILURES / _LOCK_MINUTES)', () => {
    const { clock, lockout } = setup({ maxFailures: 3, baseLockMs: 5 * MIN });
    fail(lockout, '203.0.113.7', 3);
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(5 * MIN);
    clock.advance(5 * MIN);
    fail(lockout, '203.0.113.7', 3);
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(10 * MIN);
  });

  it('only counts failures inside the rolling 15-minute window', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 19);
    clock.advance(15 * MIN + 1);
    lockout.recordFailure('203.0.113.7');
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
  });

  it('doubles the lock for repeat offenders and caps it at an hour', () => {
    const { clock, lockout } = setup();
    const expected = [2 * MIN, 4 * MIN, 8 * MIN, 16 * MIN, 32 * MIN, HOUR, HOUR];
    for (const lockMs of expected) {
      fail(lockout, '203.0.113.7', 20);
      expect(lockout.check('203.0.113.7').retryAfterMs).toBe(lockMs);
      clock.advance(lockMs);
    }
  });

  it('resets the lock level 24 hours after the last failure', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 20);
    clock.advance(2 * MIN);
    fail(lockout, '203.0.113.7', 20);
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(4 * MIN);
    clock.advance(24 * HOUR);
    fail(lockout, '203.0.113.7', 20);
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(2 * MIN);
  });

  it('clears the failure count on success but keeps the lock level', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 19);
    lockout.recordSuccess('203.0.113.7');
    fail(lockout, '203.0.113.7', 19);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
    lockout.recordFailure('203.0.113.7');
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(2 * MIN);
    clock.advance(2 * MIN);
    lockout.recordSuccess('203.0.113.7');
    fail(lockout, '203.0.113.7', 20);
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(4 * MIN);
  });

  it('shares one lock across an IPv6 /64 and across IPv4-mapped forms', () => {
    const { lockout } = setup();
    for (let i = 1; i <= 20; i += 1) lockout.recordFailure(`2001:db8:1:2::${i}`);
    expect(lockout.check('2001:db8:1:2:dead:beef:0:1').allowed).toBe(false);
    expect(lockout.check('2001:db8:1:3::1').allowed).toBe(true);

    fail(lockout, '::ffff:198.51.100.9', 10);
    fail(lockout, '198.51.100.9', 10);
    expect(lockout.check('198.51.100.9').allowed).toBe(false);
  });

  it('pauses all logins for 5 minutes after 300 failures in 15 minutes', () => {
    const { clock, lockout } = setup();
    for (let i = 0; i < 299; i += 1) lockout.recordFailure(`198.51.${i >> 8}.${i & 255}`);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
    lockout.recordFailure('198.51.100.200');
    expect(lockout.check('203.0.113.7')).toEqual({ allowed: false, retryAfterMs: 5 * MIN });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('login_global_pause'));
    clock.advance(5 * MIN);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
  });

  it('lets a venue NAT absorb many honest typos without a global pause', () => {
    const { clock, lockout } = setup();
    // 150 guests behind 3 shared addresses, one typo each, all within 15 minutes.
    for (let i = 0; i < 150; i += 1) {
      lockout.recordFailure(`203.0.113.${i % 3}`);
      lockout.recordSuccess(`203.0.113.${i % 3}`);
      clock.advance(5_000);
    }
    expect(lockout.check('203.0.113.0').allowed).toBe(true);
    expect(lockout.check('198.51.100.1').allowed).toBe(true);
  });

  /** 300 failures from untrusted addresses: trips the global pause. */
  function tripGlobalPause(lockout) {
    for (let i = 0; i < 300; i += 1) lockout.recordFailure(`198.51.${i >> 8}.${i & 255}`);
  }

  it('lets a key that logged in within 24 hours through the global pause', () => {
    const { clock, lockout } = setup();
    lockout.recordSuccess('203.0.113.7');
    clock.advance(HOUR);
    tripGlobalPause(lockout);
    // Untrusted addresses stay paused, with the same reason as before.
    expect(lockout.check('192.0.2.1')).toEqual({ allowed: false, retryAfterMs: 5 * MIN });
    expect(lockout.beginAttempt('192.0.2.1')).toMatchObject({ ok: false, reason: 'paused' });
    // The venue address (and any IPv4-mapped form of it) is not.
    expect(lockout.check('203.0.113.7')).toEqual({ allowed: true, retryAfterMs: 0 });
    const attempt = lockout.beginAttempt('::ffff:203.0.113.7');
    expect(attempt.ok).toBe(true);
    attempt.release();
  });

  it('still locks a trusted key on its own failures', () => {
    const { lockout } = setup();
    lockout.recordSuccess('203.0.113.7');
    fail(lockout, '203.0.113.7', 20);
    expect(lockout.check('203.0.113.7')).toEqual({ allowed: false, retryAfterMs: 2 * MIN });
    expect(lockout.beginAttempt('203.0.113.7')).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('does not count failures from trusted keys toward the global pause', () => {
    const { clock, lockout } = setup();
    lockout.recordSuccess('203.0.113.7');
    // 600 typos from the trusted venue address (with successes in between, as guests retry).
    for (let i = 0; i < 600; i += 1) {
      lockout.recordFailure('203.0.113.7');
      if (i % 10 === 9) lockout.recordSuccess('203.0.113.7');
      clock.advance(1_000);
    }
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('login_global_pause'));
    expect(lockout.check('192.0.2.1').allowed).toBe(true);
    // Only untrusted failures count: 299 more do not pause, the 300th does.
    for (let i = 0; i < 299; i += 1) lockout.recordFailure(`198.51.${i >> 8}.${i & 255}`);
    expect(lockout.check('192.0.2.1').allowed).toBe(true);
    lockout.recordFailure('198.51.100.250');
    expect(lockout.check('192.0.2.1').allowed).toBe(false);
  });

  it('forgets trust 24 hours after the last successful login', () => {
    const { clock, lockout } = setup();
    lockout.recordSuccess('203.0.113.7');
    clock.advance(23 * HOUR);
    lockout.recordSuccess('203.0.113.7'); // refreshes trust
    clock.advance(24 * HOUR - 1);
    tripGlobalPause(lockout);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
    clock.advance(1);
    expect(lockout.check('203.0.113.7')).toEqual({ allowed: false, retryAfterMs: 5 * MIN - 1 });
    // Pruning (at most once a minute) drops the expired trust.
    clock.advance(MIN);
    lockout.check('192.0.2.1');
    expect(lockout.trustedSize()).toBe(0);
  });

  it('never lets failures from many addresses evict trusted keys', () => {
    const { lockout } = setup({ maxKeys: 3 });
    lockout.recordSuccess('203.0.113.7');
    lockout.recordFailure('203.0.113.7');
    tripGlobalPause(lockout); // 300 distinct addresses, far beyond maxKeys
    expect(lockout.size()).toBe(3);
    expect(lockout.trustedSize()).toBe(1);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
  });

  it('caps trusted keys by dropping the fewest successes, then the oldest success', () => {
    const { clock, lockout } = setup({ maxKeys: 3 });
    lockout.recordSuccess('192.0.2.1');
    clock.advance(1_000);
    lockout.recordSuccess('192.0.2.2');
    clock.advance(1_000);
    lockout.recordSuccess('192.0.2.3');
    clock.advance(1_000);
    lockout.recordSuccess('192.0.2.1'); // 2 successes, now also the newest
    lockout.recordSuccess('192.0.2.4'); // evicts 192.0.2.2 (1 success, the oldest of those)
    lockout.recordSuccess('192.0.2.5'); // evicts 192.0.2.3
    expect(lockout.trustedSize()).toBe(3);
    tripGlobalPause(lockout);
    for (const ip of ['192.0.2.1', '192.0.2.4', '192.0.2.5']) {
      expect(lockout.check(ip).allowed).toBe(true);
    }
    expect(lockout.check('192.0.2.2').allowed).toBe(false);
    expect(lockout.check('192.0.2.3').allowed).toBe(false);
  });

  it('keeps a venue key with many logins through a flood of one-off trusted keys', () => {
    const { clock, lockout } = setup({ maxKeys: 10 });
    // The venue: the organiser and a few guests log in early, then nothing for a while.
    for (let i = 0; i < 5; i += 1) lockout.recordSuccess('203.0.113.7');
    clock.advance(HOUR);
    // 100 addresses that each log in once (e.g. one guest-password holder rotating IPv6s).
    for (let i = 0; i < 100; i += 1) {
      lockout.recordSuccess(`2001:db8:${i.toString(16)}::1`);
      clock.advance(1_000);
    }
    expect(lockout.trustedSize()).toBe(10);
    tripGlobalPause(lockout);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
  });

  it('restarts the success count once trust has expired', () => {
    const { clock, lockout } = setup({ maxKeys: 2 });
    for (let i = 0; i < 5; i += 1) lockout.recordSuccess('203.0.113.7');
    clock.advance(24 * HOUR);
    lockout.recordSuccess('203.0.113.7'); // trust had lapsed: counts as 1 again
    clock.advance(1_000);
    lockout.recordSuccess('192.0.2.1');
    lockout.recordSuccess('192.0.2.2'); // tie at 1: the oldest success (the venue) goes
    tripGlobalPause(lockout);
    expect(lockout.check('203.0.113.7').allowed).toBe(false);
    expect(lockout.check('192.0.2.1').allowed).toBe(true);
  });

  it('keeps memory bounded by dropping the oldest addresses', () => {
    const { lockout } = setup({ maxKeys: 3 });
    lockout.recordFailure('192.0.2.1');
    lockout.recordFailure('192.0.2.2');
    lockout.recordFailure('192.0.2.3');
    lockout.recordFailure('192.0.2.4');
    expect(lockout.size()).toBe(3);
  });

  it('prunes entries once they have expired', () => {
    const { clock, lockout } = setup();
    lockout.recordFailure('192.0.2.1');
    clock.advance(15 * MIN);
    lockout.check('192.0.2.2');
    expect(lockout.size()).toBe(0);
  });
});

describe('admin guess window', () => {
  const ATTACKER = '203.0.113.66';

  /**
   * A guest-password holder: log in (trusted, per-key failures cleared), 19 wrong guesses
   * (each checked against the admin hash while allowed), repeat. Returns the admin checks made.
   */
  function guestHolderGuesses(lockout, clock, rounds) {
    let adminChecks = 0;
    for (let round = 0; round < rounds; round += 1) {
      lockout.recordSuccess(ATTACKER);
      for (let i = 0; i < 19; i += 1) {
        const attempt = lockout.beginAttempt(ATTACKER);
        expect(attempt.ok).toBe(true);
        if (lockout.adminCheckAllowed()) adminChecks += 1;
        lockout.recordFailure(ATTACKER);
        attempt.release();
        clock.advance(100);
      }
    }
    return adminChecks;
  }

  it('pauses admin checks once 300 logins failed in 15 minutes, trusted keys included', () => {
    const { clock, lockout } = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 20 rounds = 380 wrong guesses, never locked (success clears the per-key count) and never
    // feeding the untrusted global pause...
    const adminChecks = guestHolderGuesses(lockout, clock, 20);
    expect(lockout.check(ATTACKER).allowed).toBe(true);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('login_global_pause'));
    // ...but only the first 300 were checked against the admin hash.
    expect(adminChecks).toBe(300);
    expect(lockout.adminCheckAllowed()).toBe(false);
    const paused = console.warn.mock.calls.filter(([line]) => line.includes('admin_check_paused'));
    expect(paused).toHaveLength(1);
    // Guest logins are unaffected: the key is neither locked nor paused.
    const attempt = lockout.beginAttempt(ATTACKER);
    expect(attempt.ok).toBe(true);
    attempt.release();
  });

  it('counts failures from every key and resumes once the window drops below the limit', () => {
    const { clock, lockout } = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    lockout.recordSuccess('203.0.113.7');
    for (let i = 0; i < 150; i += 1) lockout.recordFailure('203.0.113.7'); // trusted
    clock.advance(MIN);
    for (let i = 0; i < 149; i += 1) lockout.recordFailure(`198.51.${i >> 8}.${i & 255}`);
    expect(lockout.adminCheckAllowed()).toBe(true);
    lockout.recordFailure('198.51.100.250');
    expect(lockout.adminCheckAllowed()).toBe(false);
    // The 150 trusted failures leave the window 15 minutes after they happened.
    clock.advance(14 * MIN - 1);
    expect(lockout.adminCheckAllowed()).toBe(false);
    clock.advance(1);
    expect(lockout.adminCheckAllowed()).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('admin_check_resumed'));
    // Stays open while the window is below the limit; logs each change once.
    expect(lockout.adminCheckAllowed()).toBe(true);
    const resumed = console.log.mock.calls.filter(([line]) => line.includes('admin_check_resumed'));
    expect(resumed).toHaveLength(1);
  });

  it('keeps the admin pause independent of successful logins', () => {
    const { lockout } = setup({ adminGuessLimit: 3 });
    fail(lockout, '192.0.2.1', 3);
    expect(lockout.adminCheckAllowed()).toBe(false);
    lockout.recordSuccess('192.0.2.1');
    lockout.recordSuccess('192.0.2.2');
    expect(lockout.adminCheckAllowed()).toBe(false);
  });
});

describe('beginAttempt', () => {
  it('allows up to 3 attempts in flight for a trusted key, within the global cap', () => {
    const { lockout } = setup();
    lockout.recordSuccess('203.0.113.7');
    const held = [1, 2, 3].map(() => lockout.beginAttempt('203.0.113.7'));
    expect(held.every((a) => a.ok)).toBe(true);
    expect(lockout.beginAttempt('::ffff:203.0.113.7')).toEqual({
      ok: false,
      reason: 'busy',
      retryAfterSec: 1,
    });
    // The fourth global slot is still there for another address, then the cap applies.
    const other = lockout.beginAttempt('198.51.100.1');
    expect(other.ok).toBe(true);
    expect(lockout.beginAttempt('198.51.100.2').reason).toBe('busy');
    held[0].release();
    held[0].release(); // idempotent: frees one slot only
    expect(lockout.inFlight()).toBe(3);
    const again = lockout.beginAttempt('203.0.113.7');
    expect(again.ok).toBe(true);
    expect(lockout.beginAttempt('203.0.113.7').reason).toBe('busy');
    for (const a of [held[1], held[2], other, again]) a.release();
    expect(lockout.inFlight()).toBe(0);
  });

  it('allows one attempt in flight per untrusted client key', () => {
    const { lockout } = setup();
    const first = lockout.beginAttempt('203.0.113.7');
    expect(first.ok).toBe(true);
    expect(lockout.beginAttempt('203.0.113.7')).toEqual({
      ok: false,
      reason: 'busy',
      retryAfterSec: 1,
    });
    // IPv4-mapped form and the same IPv6 /64 share the key.
    expect(lockout.beginAttempt('::ffff:203.0.113.7').reason).toBe('busy');
    const v6 = lockout.beginAttempt('2001:db8:1:2::1');
    expect(v6.ok).toBe(true);
    expect(lockout.beginAttempt('2001:db8:1:2:ffff::9').reason).toBe('busy');
    // A different address is unaffected.
    const other = lockout.beginAttempt('198.51.100.1');
    expect(other.ok).toBe(true);
    first.release();
    v6.release();
    other.release();
    expect(lockout.inFlight()).toBe(0);
  });

  it('caps the number of attempts in flight globally', () => {
    const { lockout } = setup({ maxConcurrentAttempts: 3 });
    const held = [1, 2, 3].map((i) => lockout.beginAttempt(`192.0.2.${i}`));
    expect(held.every((a) => a.ok)).toBe(true);
    expect(lockout.beginAttempt('192.0.2.4')).toEqual({
      ok: false,
      reason: 'busy',
      retryAfterSec: 1,
    });
    held[0].release();
    const next = lockout.beginAttempt('192.0.2.4');
    expect(next.ok).toBe(true);
    next.release();
    held[1].release();
    held[2].release();
    expect(lockout.inFlight()).toBe(0);
  });

  it('defaults to 4 concurrent attempts (scrypt N=2^17 needs ~128 MiB each)', () => {
    const { lockout } = setup();
    const held = Array.from({ length: 4 }, (_, i) => lockout.beginAttempt(`192.0.2.${i}`));
    expect(held.every((a) => a.ok)).toBe(true);
    expect(lockout.beginAttempt('192.0.2.100').reason).toBe('busy');
    for (const a of held) a.release();
  });

  it('lets a released key try again, and release is idempotent', () => {
    const { lockout } = setup();
    const first = lockout.beginAttempt('203.0.113.7');
    first.release();
    const second = lockout.beginAttempt('203.0.113.7');
    expect(second.ok).toBe(true);
    // A late duplicate release of the old handle must not free the new attempt.
    first.release();
    expect(lockout.beginAttempt('203.0.113.7').reason).toBe('busy');
    second.release();
    expect(lockout.inFlight()).toBe(0);
  });

  it('releases the slot when the attempt throws (try/finally)', () => {
    const { lockout } = setup();
    const run = () => {
      const attempt = lockout.beginAttempt('203.0.113.7');
      try {
        throw new Error('boom');
      } finally {
        attempt.release();
      }
    };
    expect(run).toThrow('boom');
    expect(lockout.inFlight()).toBe(0);
    const again = lockout.beginAttempt('203.0.113.7');
    expect(again.ok).toBe(true);
    again.release();
  });

  it('rejects locked addresses and the global pause without reserving a slot', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 20);
    expect(lockout.beginAttempt('203.0.113.7')).toEqual({
      ok: false,
      reason: 'locked',
      retryAfterSec: 2 * 60,
    });
    expect(lockout.inFlight()).toBe(0);

    for (let i = 0; i < 300; i += 1) lockout.recordFailure(`198.51.${i >> 8}.${i & 255}`);
    expect(lockout.beginAttempt('192.0.2.1')).toEqual({
      ok: false,
      reason: 'paused',
      retryAfterSec: 5 * 60,
    });
    expect(lockout.inFlight()).toBe(0);
    clock.advance(5 * MIN);
    const ok = lockout.beginAttempt('192.0.2.1');
    expect(ok.ok).toBe(true);
    ok.release();
  });

  it('keeps in-flight bookkeeping when lockout entries are pruned or evicted', () => {
    const { clock, lockout } = setup({ maxKeys: 1 });
    lockout.recordFailure('203.0.113.7');
    const attempt = lockout.beginAttempt('203.0.113.7');
    // Evict the entry via the key cap, then let pruning run.
    lockout.recordFailure('192.0.2.1');
    clock.advance(24 * HOUR);
    lockout.check('192.0.2.2');
    expect(lockout.size()).toBe(0);
    expect(lockout.beginAttempt('203.0.113.7').reason).toBe('busy');
    attempt.release();
    expect(lockout.inFlight()).toBe(0);
  });
});
