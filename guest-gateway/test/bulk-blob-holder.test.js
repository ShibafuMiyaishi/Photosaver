// guest-gateway/test/bulk-blob-holder.test.js
// Android の「まとめて保存」で、ダウンロードに渡したファイルが使うメモリの上限を守る仕組み
// (public/bulk.js の createBlobHolder)のテスト。

import { vi } from 'vitest';
import { BulkError, createBlobHolder } from '../public/bulk.js';

const MB = 1024 ** 2;

function holderForTest() {
  return createBlobHolder({ budget: 600 * MB, ttlMs: 60_000, revoke: () => {} });
}

describe('createBlobHolder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('releases each URL after the TTL', () => {
    const revoked = [];
    const holder = createBlobHolder({
      budget: 600 * MB,
      ttlMs: 60_000,
      revoke: (url) => revoked.push(url),
    });
    holder.hold('blob:a', 100 * MB);
    expect(holder.liveBytes).toBe(100 * MB);
    expect(holder.room()).toBe(500 * MB);
    vi.advanceTimersByTime(59_999);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(['blob:a']);
    expect(holder.liveBytes).toBe(0);
  });

  it('lets a file through at once when it fits, or when nothing is held', async () => {
    const holder = holderForTest();
    expect(holder.mustWait(700 * MB)).toBe(false);
    await holder.waitFor(700 * MB);
    holder.hold('blob:a', 500 * MB);
    expect(holder.mustWait(100 * MB)).toBe(false);
    expect(holder.mustWait(101 * MB)).toBe(true);
  });

  it('waits until enough older URLs have been released', async () => {
    const holder = holderForTest();
    holder.hold('blob:a', 300 * MB);
    vi.advanceTimersByTime(10_000);
    holder.hold('blob:b', 250 * MB);
    let done = false;
    const waiting = holder.waitFor(200 * MB).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(done).toBe(false);
    // blob:a released (250 MB left): another 200 MB fits.
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
    expect(holder.liveBytes).toBe(250 * MB);
  });

  it('stops waiting when the run is stopped', async () => {
    const holder = holderForTest();
    holder.hold('blob:a', 550 * MB);
    const controller = new AbortController();
    const waiting = holder.waitFor(100 * MB, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(BulkError);
    await expect(holder.waitFor(100 * MB, controller.signal)).rejects.toThrow('stopped');
  });
});
