// guest-gateway/test/importer.test.js
// 取り込みキューを偽の Immich クライアントで検証する(成功・再試行・確定失敗で failed/ へ退避・並列数・停止・再開)。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ImmichError } from '../src/immich.js';
import { createImporter, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_DELAYS_MS } from '../src/importer.js';
import { openStore } from '../src/store.js';
import { TMP_ROOT } from './helpers/server.js';

const ASSET_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('import queue', () => {
  let dir;
  let failedDir;
  let store;
  let importer;

  async function receive(uploadId) {
    await fs.writeFile(path.join(dir, uploadId), 'bytes');
    store.add({
      uploadId,
      deviceId: 'dev-1',
      nickname: 'たろう',
      filename: `${uploadId}.jpg`,
      mime: 'image/jpeg',
      size: 5,
      lastModified: 1_790_000_000_000,
    });
  }

  const exists = (uploadId, inDir = dir) =>
    fs.stat(path.join(inDir, uploadId)).then(
      () => true,
      () => false,
    );

  function start(uploadAsset, options = {}) {
    importer = createImporter({
      store,
      immich: { uploadAsset },
      dir,
      failedDir,
      retryDelaysMs: [5],
      ...options,
    });
    return importer;
  }

  beforeEach(async () => {
    const root = path.join(TMP_ROOT, `importer-${crypto.randomUUID()}`);
    dir = path.join(root, 'importing');
    failedDir = path.join(root, 'failed');
    await fs.mkdir(dir, { recursive: true });
    store = openStore(':memory:');
  });

  afterEach(async () => {
    importer?.stop();
    store.close();
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  });

  it('uploads a received file, records the asset and removes the staged copy', async () => {
    const calls = [];
    start(async (file) => {
      calls.push(file);
      return { status: 'created', id: ASSET_ID };
    });
    await receive('u1');
    importer.enqueue('u1');
    await importer.idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      filePath: path.join(dir, 'u1'),
      filename: 'u1.jpg',
      mime: 'image/jpeg',
      lastModified: 1_790_000_000_000,
    });
    expect(store.get('u1')).toMatchObject({ status: 'created', asset_id: ASSET_ID, attempts: 1 });
    expect(await exists('u1')).toBe(false);
    expect(await exists('u1', failedDir)).toBe(false);
  });

  it('records duplicates with the existing asset id', async () => {
    start(async () => ({ status: 'duplicate', id: ASSET_ID }));
    await receive('u1');
    importer.enqueue('u1');
    await importer.idle();
    expect(store.get('u1')).toMatchObject({ status: 'duplicate', asset_id: ASSET_ID });
    expect(await exists('u1')).toBe(false);
  });

  it.each([[0], [401], [404], [429], [503]])(
    'retries transient failures (status %s) and keeps the file until it succeeds',
    async (status) => {
      let calls = 0;
      start(async () => {
        calls += 1;
        if (calls < 3) throw new ImmichError('upload', status);
        return { status: 'created', id: ASSET_ID };
      });
      await receive('u1');
      importer.enqueue('u1');
      await importer.idle();
      expect(calls).toBe(3);
      expect(store.get('u1')).toMatchObject({ status: 'created', attempts: 3 });
    },
  );

  it.each([[400], [413], [415], [422]])(
    'gives up at once when Immich rejects the file (status %s) and keeps it in failed/',
    async (status) => {
      let calls = 0;
      start(async () => {
        calls += 1;
        throw new ImmichError('upload', status);
      });
      await receive('u1');
      importer.enqueue('u1');
      await importer.idle();
      expect(calls).toBe(1);
      expect(store.get('u1').status).toBe('failed');
      expect(await exists('u1')).toBe(false);
      expect(await fs.readFile(path.join(failedDir, 'u1'), 'utf8')).toBe('bytes');
    },
  );

  it('keeps retrying a transient Immich outage for at least a day by default', () => {
    let totalMs = 0;
    for (let attempt = 1; attempt < DEFAULT_MAX_ATTEMPTS; attempt += 1) {
      totalMs += DEFAULT_RETRY_DELAYS_MS[Math.min(attempt, DEFAULT_RETRY_DELAYS_MS.length) - 1];
    }
    expect(totalMs).toBeGreaterThanOrEqual(24 * 60 * 60_000);
  });

  it('gives up after maxAttempts transient failures and keeps the file in failed/', async () => {
    let calls = 0;
    start(
      async () => {
        calls += 1;
        throw new ImmichError('upload', 503);
      },
      { maxAttempts: 3 },
    );
    await receive('u1');
    importer.enqueue('u1');
    await importer.idle();
    expect(calls).toBe(3);
    expect(store.get('u1')).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await exists('u1')).toBe(false);
    expect(await exists('u1', failedDir)).toBe(true);
  });

  it('leaves a given-up file in importing/ when it cannot be moved to failed/', async () => {
    // A plain file where failed/ should be: mkdir and rename both fail.
    await fs.writeFile(failedDir, 'not a directory');
    start(async () => {
      throw new ImmichError('upload', 400);
    });
    await receive('u1');
    importer.enqueue('u1');
    await importer.idle();
    expect(store.get('u1').status).toBe('failed');
    expect(await exists('u1')).toBe(true);
  });

  it('marks a row failed without calling Immich when the staged file is gone', async () => {
    let calls = 0;
    start(async () => {
      calls += 1;
      return { status: 'created', id: ASSET_ID };
    });
    await receive('u1');
    await fs.rm(path.join(dir, 'u1'));
    importer.enqueue('u1');
    await importer.idle();
    expect(calls).toBe(0);
    expect(store.get('u1').status).toBe('failed');
  });

  it('runs at most `concurrency` uploads at once and ignores duplicate or unsafe ids', async () => {
    let running = 0;
    let peak = 0;
    const seen = [];
    start(
      async ({ filePath }) => {
        seen.push(path.basename(filePath));
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        return { status: 'created', id: ASSET_ID };
      },
      { concurrency: 2 },
    );
    for (const id of ['u1', 'u2', 'u3', 'u4']) await receive(id);
    for (const id of ['u1', 'u2', 'u1', 'u3', 'u4', '../etc/passwd', '']) importer.enqueue(id);
    await importer.idle();
    expect(peak).toBe(2);
    expect(seen.sort()).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('resumes pending rows after a restart', async () => {
    await receive('u1');
    await receive('u2');
    store.markImported('u2', 'created', ASSET_ID);
    const seen = [];
    start(async ({ filePath }) => {
      seen.push(path.basename(filePath));
      return { status: 'created', id: ASSET_ID };
    });
    expect(importer.resume()).toBe(1);
    await importer.idle();
    expect(seen).toEqual(['u1']);
  });

  it('stop() aborts in-flight uploads and leaves them pending with the file kept', async () => {
    let started;
    const inFlight = new Promise((r) => {
      started = r;
    });
    start(
      ({ signal }) =>
        new Promise((_resolve, rejectUpload) => {
          started();
          signal.addEventListener('abort', () => rejectUpload(new ImmichError('upload', 0)));
        }),
    );
    await receive('u1');
    importer.enqueue('u1');
    await inFlight;
    importer.stop();
    await importer.idle();
    expect(store.get('u1').status).toBe('pending');
    expect(await exists('u1')).toBe(true);
  });

  it.each([[0], [500], [502], [503]])(
    'a duplicate after an ambiguous attempt (status %s) is recorded as created',
    async (status) => {
      let calls = 0;
      start(async () => {
        calls += 1;
        // The first attempt reached Immich, but the answer was lost.
        if (calls === 1) throw new ImmichError('upload', status);
        return { status: 'duplicate', id: ASSET_ID };
      });
      await receive('u1');
      importer.enqueue('u1');
      await importer.idle();
      expect(store.get('u1')).toMatchObject({ status: 'created', asset_id: ASSET_ID });
      expect(store.isOwnAsset(ASSET_ID, 'dev-1')).toBe(true);
      expect(store.uploaders([ASSET_ID]).get(ASSET_ID)).toEqual({
        nickname: 'たろう',
        deviceId: 'dev-1',
      });
    },
  );

  it.each([[401], [404], [429]])(
    'a duplicate after a refused attempt (status %s) stays a duplicate',
    async (status) => {
      let calls = 0;
      start(async () => {
        calls += 1;
        if (calls === 1) throw new ImmichError('upload', status);
        return { status: 'duplicate', id: ASSET_ID };
      });
      await receive('u1');
      importer.enqueue('u1');
      await importer.idle();
      expect(store.get('u1').status).toBe('duplicate');
    },
  );

  it('a duplicate after an ambiguous attempt stays a duplicate when someone else created it', async () => {
    store.add({
      uploadId: 'theirs',
      deviceId: 'dev-2',
      nickname: 'はなこ',
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 5,
      lastModified: null,
    });
    store.markImported('theirs', 'created', ASSET_ID);
    let calls = 0;
    start(async () => {
      calls += 1;
      if (calls === 1) throw new ImmichError('upload', 0);
      return { status: 'duplicate', id: ASSET_ID };
    });
    await receive('u1');
    importer.enqueue('u1');
    await importer.idle();
    expect(store.get('u1').status).toBe('duplicate');
    expect(store.isOwnAsset(ASSET_ID, 'dev-1')).toBe(false);
  });

  it('reverts a reclaim when another device then genuinely creates the same asset', async () => {
    // u1's first attempt is ambiguous and its retry gets `duplicate` (reclaimed as created);
    // u2 (another device, same bytes) was still on its way and Immich reports it as created.
    let releaseU2;
    const u2Answer = new Promise((r) => {
      releaseU2 = r;
    });
    let u1Calls = 0;
    start(async ({ filePath }) => {
      if (filePath.endsWith('u2')) {
        await u2Answer;
        return { status: 'created', id: ASSET_ID };
      }
      u1Calls += 1;
      if (u1Calls === 1) throw new ImmichError('upload', 0);
      return { status: 'duplicate', id: ASSET_ID };
    });
    await receive('u1');
    store.add({
      uploadId: 'u2',
      deviceId: 'dev-2',
      nickname: 'はなこ',
      filename: 'u2.jpg',
      mime: 'image/jpeg',
      size: 5,
      lastModified: null,
    });
    await fs.writeFile(path.join(dir, 'u2'), 'bytes');
    importer.enqueue('u2');
    importer.enqueue('u1');
    await expect.poll(() => store.get('u1').status).toBe('created');
    expect(store.get('u1').reclaimed).toBe(1);

    releaseU2();
    await importer.idle();
    expect(store.get('u1')).toMatchObject({ status: 'duplicate', reclaimed: 0 });
    expect(store.get('u2')).toMatchObject({ status: 'created', asset_id: ASSET_ID });
    expect(store.isOwnAsset(ASSET_ID, 'dev-1')).toBe(false);
    expect(store.isOwnAsset(ASSET_ID, 'dev-2')).toBe(true);
  });

  it('treats an attempt left in flight by a crash as ambiguous after the restart', async () => {
    await receive('u1');
    store.addAttempt('u1'); // the previous process died during this attempt
    start(async () => ({ status: 'duplicate', id: ASSET_ID }));
    importer.resume();
    await importer.idle();
    expect(store.get('u1')).toMatchObject({ status: 'created', attempts: 2 });
  });

  it('treats an attempt aborted by stop() as ambiguous on the next start', async () => {
    let started;
    const inFlight = new Promise((r) => {
      started = r;
    });
    start(
      ({ signal }) =>
        new Promise((_resolve, rejectUpload) => {
          started();
          signal.addEventListener('abort', () => rejectUpload(new ImmichError('upload', 0)));
        }),
    );
    await receive('u1');
    importer.enqueue('u1');
    await inFlight;
    importer.stop();
    await importer.idle();
    expect(store.get('u1')).toMatchObject({ status: 'pending', ambiguous: 1, in_flight: 0 });

    start(async () => ({ status: 'duplicate', id: ASSET_ID }));
    importer.resume();
    await importer.idle();
    expect(store.get('u1').status).toBe('created');
  });

  it('an ambiguous attempt does not reclaim an asset deleted here (trashed copy)', async () => {
    store.add({
      uploadId: 'old',
      deviceId: 'dev-1',
      nickname: 'たろう',
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 5,
      lastModified: null,
    });
    store.markImported('old', 'duplicate', ASSET_ID);
    store.markDeleted(ASSET_ID);
    let calls = 0;
    importer = createImporter({
      store,
      immich: {
        uploadAsset: async () => {
          calls += 1;
          if (calls === 1) throw new ImmichError('upload', 503);
          return { status: 'duplicate', id: ASSET_ID };
        },
        isAssetVisible: async () => false,
      },
      dir,
      failedDir,
      retryDelaysMs: [5],
    });
    await receive('u1');
    importer.enqueue('u1');
    await importer.idle();
    expect(store.get('u1').status).toBe('trashed');
  });

  it.each([
    [false, 'trashed', true],
    [true, 'duplicate', false],
  ])(
    're-upload of an asset deleted here: visible=%s → %s',
    async (visible, expected, stillMarked) => {
      importer = createImporter({
        store,
        immich: {
          uploadAsset: async () => ({ status: 'duplicate', id: ASSET_ID }),
          // Trashed assets are not readable through the share link; restored ones are.
          isAssetVisible: async () => visible,
        },
        dir,
        failedDir,
        retryDelaysMs: [5],
      });
      store.add({
        uploadId: 'old',
        deviceId: 'dev-1',
        nickname: 'たろう',
        filename: 'a.jpg',
        mime: 'image/jpeg',
        size: 5,
        lastModified: null,
      });
      store.markImported('old', 'created', ASSET_ID);
      store.markDeleted(ASSET_ID);
      await receive('u1');
      importer.enqueue('u1');
      await importer.idle();
      expect(store.get('u1')).toMatchObject({ status: expected, asset_id: ASSET_ID });
      expect(store.wasDeleted(ASSET_ID)).toBe(stillMarked);
    },
  );
});
