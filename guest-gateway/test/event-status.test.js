// guest-gateway/test/event-status.test.js
// 当日の状況確認スクリプトの表示: 期限までの残り時間、件数、詰まり・失敗の警告。

import { formatBytes, formatStatus, STUCK_PENDING_MS } from '../scripts/event-status.js';

const NOW = Date.parse('2026-10-10T12:00:00+09:00');

function stats(overrides = {}) {
  const byStatus = {
    pending: { count: 0, bytes: 0 },
    created: { count: 120, bytes: 3 * 1024 ** 3 },
    duplicate: { count: 2, bytes: 2048 },
    failed: { count: 0, bytes: 0 },
    trashed: { count: 0, bytes: 0 },
    ...overrides.byStatus,
  };
  return { devices: 15, deleted: 1, oldestPendingAt: null, ...overrides, byStatus };
}

describe('event status', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('shows the time left, counts and free space with no warnings when healthy', () => {
    const { lines, warnings } = formatStatus(stats(), {
      now: NOW,
      closesAt: NOW + (3 * 60 + 12) * 60_000,
      freeBytes: 500 * 1024 ** 3,
    });
    expect(lines).toContain('受付期限まで: あと3時間12分');
    expect(
      formatStatus(stats(), { now: NOW, closesAt: NOW + 30_000, freeBytes: null }).lines[0],
    ).toBe('受付期限まで: あと1分未満');
    expect(lines).toContain('取り込み済み: 120件 (3.0 GB)');
    expect(lines).toContain('投稿した端末: 15台');
    expect(lines).toContain('HDD の空き: 500.0 GB');
    expect(warnings).toEqual([]);
  });

  it('warns about stuck and failed imports, and says when the gateway has closed', () => {
    const { lines, warnings } = formatStatus(
      stats({
        byStatus: { pending: { count: 3, bytes: 10 }, failed: { count: 1, bytes: 5 } },
        oldestPendingAt: NOW - STUCK_PENDING_MS - 60_000,
      }),
      { now: NOW, closesAt: NOW - 1, freeBytes: null },
    );
    expect(lines[0]).toMatch(/終了済み/);
    expect(lines.some((l) => l.startsWith('HDD'))).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/import_retry/);
    expect(warnings[1]).toMatch(/import_failed/);
    expect(warnings[1]).toMatch(/failed\/.*requeue-failed\.js/);
  });

  it('does not warn about a pending row that only just arrived', () => {
    const { warnings } = formatStatus(
      stats({ byStatus: { pending: { count: 1, bytes: 1 } }, oldestPendingAt: NOW - 30_000 }),
      { now: NOW, closesAt: null, freeBytes: null },
    );
    expect(warnings).toEqual([]);
  });
});
