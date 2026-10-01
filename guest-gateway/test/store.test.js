// guest-gateway/test/store.test.js

import { openStore } from '../src/store.js';

const ROW = {
  uploadId: 'abc123',
  deviceId: 'dev-1',
  nickname: 'たろう',
  filename: 'IMG_0001.HEIC',
  mime: 'image/heic',
  size: 1234,
  lastModified: 1_790_000_000_000,
};

describe('upload store', () => {
  let store;
  let clock;
  beforeEach(() => {
    clock = 1000;
    store = openStore(':memory:', { now: () => clock++ });
  });
  afterEach(() => store.close());

  it('records a received file as pending, once', () => {
    store.add(ROW);
    store.add({ ...ROW, nickname: 'ignored' });
    expect(store.get('abc123')).toMatchObject({
      device_id: 'dev-1',
      nickname: 'たろう',
      status: 'pending',
      attempts: 0,
      asset_id: null,
    });
    expect(store.listPending()).toHaveLength(1);
  });

  it('tracks attempts and the import result', () => {
    store.add(ROW);
    expect(store.addAttempt('abc123')).toBe(1);
    expect(store.addAttempt('abc123')).toBe(2);
    store.markImported('abc123', 'created', '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b');
    expect(store.get('abc123')).toMatchObject({
      status: 'created',
      asset_id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    });
    expect(store.listPending()).toHaveLength(0);
  });

  it('lists only the caller device, newest first, without internal fields', () => {
    store.add(ROW);
    store.add({ ...ROW, uploadId: 'def456', filename: 'IMG_0002.MOV' });
    store.add({ ...ROW, uploadId: 'other', deviceId: 'dev-2' });
    store.markFailed('abc123');
    expect(store.listForDevice('dev-1')).toEqual([
      { id: 'def456', filename: 'IMG_0002.MOV', status: 'pending' },
      { id: 'abc123', filename: 'IMG_0001.HEIC', status: 'failed' },
    ]);
    expect(store.listForDevice('dev-3')).toEqual([]);
  });

  it('returns the status of requested ids, only for the caller device', () => {
    store.add(ROW);
    store.add({ ...ROW, uploadId: 'other', deviceId: 'dev-2' });
    expect(store.statusForDevice('dev-1', ['abc123', 'other', 'missing'])).toEqual([
      { id: 'abc123', filename: 'IMG_0001.HEIC', status: 'pending' },
    ]);
    expect(store.statusForDevice('dev-1', [])).toEqual([]);
  });

  it('maps assets to their first creating uploader and ownership', () => {
    const asset = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    store.add({ ...ROW, uploadId: 'first', deviceId: 'dev-2', nickname: 'はなこ' });
    store.markImported('first', 'created', asset);
    store.add({ ...ROW, uploadId: 'again' });
    store.markImported('again', 'duplicate', asset);
    store.add({ ...ROW, uploadId: 'pending' });

    expect(store.uploaders([asset, 'unknown'])).toEqual(
      new Map([[asset, { nickname: 'はなこ', deviceId: 'dev-2' }]]),
    );
    expect(store.uploaders([]).size).toBe(0);
  });

  it('looks up albums larger than one query chunk', () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `asset-${i}`);
    ids.forEach((assetId, i) => {
      store.add({ ...ROW, uploadId: `u${i}`, nickname: `n${i}` });
      store.markImported(`u${i}`, 'created', assetId);
    });
    const found = store.uploaders(ids);
    expect(found.size).toBe(1201);
    expect(found.get('asset-1200').nickname).toBe('n1200');
  });

  it('decides ownership by created uploads only and keeps it across delete and restore', () => {
    const asset = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    store.add({ ...ROW, uploadId: 'mine' });
    store.markImported('mine', 'created', asset);
    store.add({ ...ROW, uploadId: 'copy', deviceId: 'dev-2' });
    store.markImported('copy', 'duplicate', asset);
    expect(store.isOwnAsset(asset, 'dev-1')).toBe(true);
    expect(store.isOwnAsset(asset, 'dev-2')).toBe(false);

    expect(store.wasDeleted(asset)).toBe(false);
    store.markDeleted(asset);
    expect(store.wasDeleted(asset)).toBe(true);
    // Statuses are untouched, so a restore in Immich brings attribution and ownership back.
    expect(store.get('mine').status).toBe('created');
    expect(store.get('copy').status).toBe('duplicate');
    expect(store.isOwnAsset(asset, 'dev-1')).toBe(true);
    expect(store.uploaders([asset]).get(asset).nickname).toBe('たろう');
    store.clearDeleted(asset);
    expect(store.wasDeleted(asset)).toBe(false);
  });

  it('adds deleted_at to a database created before it existed', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { TMP_ROOT } = await import('./helpers/server.js');
    await fs.mkdir(TMP_ROOT, { recursive: true });
    const file = path.join(TMP_ROOT, `old-${Date.now()}.db`);
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE uploads (upload_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
      nickname TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
      last_modified INTEGER, status TEXT NOT NULL DEFAULT 'pending', asset_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    old.close();
    const migrated = openStore(file);
    try {
      migrated.add(ROW);
      migrated.markImported(ROW.uploadId, 'created', 'a1');
      migrated.markDeleted('a1');
      expect(migrated.wasDeleted('a1')).toBe(true);
    } finally {
      migrated.close();
      await fs.rm(file, { force: true });
      await fs.rm(`${file}-wal`, { force: true });
      await fs.rm(`${file}-shm`, { force: true });
    }
  });

  it('summarizes counts for the operator, per asset for deletions', () => {
    store.add(ROW);
    store.add({ ...ROW, uploadId: 'u2', size: 100 });
    store.markImported('u2', 'created', 'a2');
    store.add({ ...ROW, uploadId: 'u3', deviceId: 'dev-2', size: 10 });
    store.markImported('u3', 'duplicate', 'a2');
    store.add({ ...ROW, uploadId: 'u4', deviceId: 'dev-2' });
    store.markFailed('u4');
    store.markDeleted('a2');
    expect(store.stats()).toEqual({
      byStatus: {
        pending: { count: 1, bytes: 1234 },
        created: { count: 1, bytes: 100 },
        duplicate: { count: 1, bytes: 10 },
        failed: { count: 1, bytes: 1234 },
        trashed: { count: 0, bytes: 0 },
      },
      devices: 2,
      deleted: 1,
      oldestPendingAt: 1000,
    });
  });

  it('opens read-only next to a running gateway without writing', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { TMP_ROOT } = await import('./helpers/server.js');
    await fs.mkdir(TMP_ROOT, { recursive: true });
    const file = path.join(TMP_ROOT, `ro-${Date.now()}.db`);
    const live = openStore(file);
    const reader = openStore(file, { readOnly: true });
    try {
      live.add(ROW);
      expect(reader.stats().byStatus.pending.count).toBe(1);
      expect(() => reader.add({ ...ROW, uploadId: 'other' })).toThrow();
    } finally {
      reader.close();
      live.close();
      for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${file}${suffix}`, { force: true });
    }
  });
});
