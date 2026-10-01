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

describe('beginAttempt', () => {
  it('allows one attempt in flight per client key', () => {
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

  it('defaults to 8 concurrent attempts', () => {
    const { lockout } = setup();
    const held = Array.from({ length: 8 }, (_, i) => lockout.beginAttempt(`192.0.2.${i}`));
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
