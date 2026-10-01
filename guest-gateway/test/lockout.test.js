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
  it('locks an address on the 5th failure within 15 minutes for 15 minutes', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 4);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
    lockout.recordFailure('203.0.113.7');
    expect(lockout.check('203.0.113.7')).toEqual({ allowed: false, retryAfterMs: 15 * MIN });
    // Other addresses are unaffected.
    expect(lockout.check('198.51.100.1').allowed).toBe(true);
    clock.advance(15 * MIN);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
  });

  it('only counts failures inside the rolling 15-minute window', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 4);
    clock.advance(15 * MIN + 1);
    lockout.recordFailure('203.0.113.7');
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
  });

  it('doubles the lock for repeat offenders and caps it at 24 hours', () => {
    const { clock, lockout } = setup();
    const expected = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, 24 * HOUR];
    for (const lockMs of expected) {
      fail(lockout, '203.0.113.7', 5);
      expect(lockout.check('203.0.113.7').retryAfterMs).toBe(lockMs);
      clock.advance(lockMs);
    }
  });

  it('resets the lock level 24 hours after the last failure', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 5);
    clock.advance(15 * MIN);
    fail(lockout, '203.0.113.7', 5);
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(30 * MIN);
    clock.advance(24 * HOUR);
    fail(lockout, '203.0.113.7', 5);
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(15 * MIN);
  });

  it('clears the failure count on success but keeps the lock level', () => {
    const { clock, lockout } = setup();
    fail(lockout, '203.0.113.7', 4);
    lockout.recordSuccess('203.0.113.7');
    fail(lockout, '203.0.113.7', 4);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
    lockout.recordFailure('203.0.113.7');
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(15 * MIN);
    clock.advance(15 * MIN);
    lockout.recordSuccess('203.0.113.7');
    fail(lockout, '203.0.113.7', 5);
    expect(lockout.check('203.0.113.7').retryAfterMs).toBe(30 * MIN);
  });

  it('shares one lock across an IPv6 /64 and across IPv4-mapped forms', () => {
    const { lockout } = setup();
    for (let i = 1; i <= 5; i += 1) lockout.recordFailure(`2001:db8:1:2::${i}`);
    expect(lockout.check('2001:db8:1:2:dead:beef:0:1').allowed).toBe(false);
    expect(lockout.check('2001:db8:1:3::1').allowed).toBe(true);

    fail(lockout, '::ffff:198.51.100.9', 3);
    fail(lockout, '198.51.100.9', 2);
    expect(lockout.check('198.51.100.9').allowed).toBe(false);
  });

  it('pauses all logins for 5 minutes after 100 failures in 15 minutes', () => {
    const { clock, lockout } = setup();
    for (let i = 0; i < 99; i += 1) lockout.recordFailure(`198.51.100.${i}`);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
    lockout.recordFailure('198.51.100.200');
    expect(lockout.check('203.0.113.7')).toEqual({ allowed: false, retryAfterMs: 5 * MIN });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('login_global_pause'));
    clock.advance(5 * MIN);
    expect(lockout.check('203.0.113.7').allowed).toBe(true);
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
