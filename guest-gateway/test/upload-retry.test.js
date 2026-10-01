// guest-gateway/test/upload-retry.test.js
// ブラウザ側のアップロード失敗の分類と自動再試行の間隔(public/upload-retry.js)のテスト。

import {
  AUTO_RETRY_DELAYS_MS,
  autoRetryDelay,
  isPermanentFailure,
  isTransientFailure,
} from '../public/upload-retry.js';

describe('upload failure classification', () => {
  it('treats network errors, 5xx and busy/conflict statuses as transient', () => {
    for (const status of [undefined, 0, 500, 502, 503, 504, 408, 409, 423, 429]) {
      expect(isTransientFailure(status), String(status)).toBe(true);
      expect(isPermanentFailure(status), String(status)).toBe(false);
    }
  });

  it('never retries what re-sending cannot fix', () => {
    for (const status of [400, 403, 404, 413, 415, 507]) {
      expect(isPermanentFailure(status), String(status)).toBe(true);
      expect(isTransientFailure(status), String(status)).toBe(false);
    }
  });

  it('leaves 401 to the re-login flow (neither permanent nor retried by itself)', () => {
    expect(isPermanentFailure(401)).toBe(false);
    expect(isTransientFailure(401)).toBe(false);
  });
});

describe('autoRetryDelay', () => {
  it('backs off and stays at the cap', () => {
    const mid = () => 0.5; // no jitter
    expect(autoRetryDelay(0, mid)).toBe(AUTO_RETRY_DELAYS_MS[0]);
    expect(autoRetryDelay(1, mid)).toBe(AUTO_RETRY_DELAYS_MS[1]);
    const cap = AUTO_RETRY_DELAYS_MS.at(-1);
    expect(autoRetryDelay(AUTO_RETRY_DELAYS_MS.length - 1, mid)).toBe(cap);
    expect(autoRetryDelay(50, mid)).toBe(cap);
  });

  it('adds at most ±20% jitter', () => {
    expect(autoRetryDelay(0, () => 0)).toBe(AUTO_RETRY_DELAYS_MS[0] * 0.8);
    expect(autoRetryDelay(0, () => 0.999999)).toBeLessThanOrEqual(AUTO_RETRY_DELAYS_MS[0] * 1.2);
  });
});
