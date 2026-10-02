// guest-gateway/test/login-retry.test.js
// ログインが 429 'busy' のときの自動再試行の間隔(public/login-retry.js)のテスト。

import {
  LOGIN_BUSY_MAX_MS,
  LOGIN_BUSY_MAX_RETRIES,
  loginBusyDelay,
} from '../public/login-retry.js';

const noJitter = () => 0;
const fullJitter = () => 0.999999;

describe('loginBusyDelay', () => {
  it('waits at least Retry-After (and never less than 1 s)', () => {
    expect(loginBusyDelay({ retry: 1, elapsedMs: 0, retryAfter: '1', random: noJitter })).toBe(
      1000,
    );
    expect(loginBusyDelay({ retry: 1, elapsedMs: 0, retryAfter: '3', random: noJitter })).toBe(
      3000,
    );
    for (const retryAfter of [null, undefined, '', '0', 'soon', '-5']) {
      expect(
        loginBusyDelay({ retry: 1, elapsedMs: 0, retryAfter, random: noJitter }),
        String(retryAfter),
      ).toBe(1000);
    }
  });

  it('adds jitter that grows from 1 s to at most 3 s', () => {
    const jitter = (retry) =>
      loginBusyDelay({ retry, elapsedMs: 0, retryAfter: '1', random: fullJitter }) - 1000;
    expect(jitter(1)).toBeLessThanOrEqual(1000);
    expect(jitter(1)).toBeGreaterThan(990);
    expect(jitter(5)).toBeGreaterThan(jitter(1));
    expect(jitter(LOGIN_BUSY_MAX_RETRIES)).toBeLessThanOrEqual(3000);
    expect(jitter(LOGIN_BUSY_MAX_RETRIES)).toBeGreaterThan(2990);
  });

  it('keeps retrying for about 45 s, then gives up', () => {
    expect(
      loginBusyDelay({ retry: 2, elapsedMs: LOGIN_BUSY_MAX_MS - 1, retryAfter: '1' }),
    ).not.toBeNull();
    expect(loginBusyDelay({ retry: 2, elapsedMs: LOGIN_BUSY_MAX_MS, retryAfter: '1' })).toBeNull();
  });

  it('caps the number of retries', () => {
    expect(
      loginBusyDelay({ retry: LOGIN_BUSY_MAX_RETRIES, elapsedMs: 0, retryAfter: '1' }),
    ).not.toBeNull();
    expect(
      loginBusyDelay({ retry: LOGIN_BUSY_MAX_RETRIES + 1, elapsedMs: 0, retryAfter: '1' }),
    ).toBeNull();
  });

  it('spends about 45 s in a rush that never clears (well beyond the old 5–10 s)', () => {
    let elapsedMs = 0;
    let retries = 0;
    for (let retry = 1; ; retry += 1) {
      const delay = loginBusyDelay({ retry, elapsedMs, retryAfter: '1', random: () => 0.5 });
      if (delay === null) break;
      retries = retry;
      elapsedMs += delay + 300; // + the server's answer
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(LOGIN_BUSY_MAX_MS);
    expect(elapsedMs).toBeLessThan(LOGIN_BUSY_MAX_MS + 5000);
    expect(retries).toBeLessThanOrEqual(LOGIN_BUSY_MAX_RETRIES);
  });
});
