// guest-gateway/test/importer.test.js
// 取り込みキューを偽の Immich クライアントで検証する(成功・再試行・確定失敗・並列数・停止・再開)。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ImmichError } from '../src/immich.js';
import { createImporter } from '../src/importer.js';
import { openStore } from '../src/store.js';
import { TMP_ROOT } from './helpers/server.js';

const ASSET_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('import queue', () => {
  let dir;
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

  const exists = (uploadId) =>
    fs.stat(path.join(dir, uploadId)).then(
      () => true,
      () => false,
    );

  function start(uploadAsset, options = {}) {
    importer = createImporter({
      store,
      immich: { uploadAsset },
      dir,
      retryDelaysMs: [5],
      ...options,
    });
    return importer;
  }

  beforeEach(async () => {
    dir = path.join(TMP_ROOT, `importer-${crypto.randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    store = openStore(':memory:');
  });

  afterEach(async () => {
    importer?.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
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
  });

  it('records duplicates with the existing asset id', async () => {
    start(async () => ({ status: 'duplicate', id: ASSET_ID }));
    await receive('u1');
    importer.enqueue('u1');
    await importer.idle();
    expect(store.get('u1')).toMatchObject({ status: 'duplicate', asset_id: ASSET_ID });
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
    'gives up at once when Immich rejects the file (status %s)',
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
    },
  );

  it('gives up after maxAttempts transient failures', async () => {
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

  it('records a re-upload of an asset deleted here as trashed (it stays out of the album)', async () => {
    start(async () => ({ status: 'duplicate', id: ASSET_ID }));
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
    expect(store.get('u1')).toMatchObject({ status: 'trashed', asset_id: ASSET_ID });
  });
});
