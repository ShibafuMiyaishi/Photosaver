// guest-gateway/test/import-mode.test.js
// 取り込みモードの受入テスト: tus で上げた写真が取り込みキューに渡り、ニックネーム・端末付きで
// 記録され、本人だけが状態を見られること。Immich は偽クライアントで置き換える。

import fs from 'node:fs/promises';
import path from 'node:path';
import * as tus from 'tus-js-client';
import { createImporter } from '../src/importer.js';
import { openStore } from '../src/store.js';
import { FAILED_DIR_NAME, IMPORT_DIR_NAME, purgeStaging } from '../src/uploads.js';
import { login, startServer } from './helpers/server.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const CSRF = { 'X-Requested-With': 'guest-gateway' };
const ASSET_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

function tusUpload(baseUrl, cookie, data, filename, metadata = {}) {
  return new Promise((resolve) => {
    const upload = new tus.Upload(data, {
      endpoint: `${baseUrl}/files/`,
      headers: { ...CSRF, Cookie: cookie },
      metadata: { filename, filetype: 'image/png', lastModified: '1790000000000', ...metadata },
      uploadSize: data.length,
      retryDelays: [],
      onSuccess: () => resolve({ ok: true, id: new URL(upload.url).pathname.split('/').pop() }),
      onError: (err) => resolve({ ok: false, status: err.originalResponse?.getStatus() }),
    });
    upload.start();
  });
}

describe('import mode', () => {
  let srv;
  let store;
  let importer;
  let uploads;
  let release;

  beforeEach(async () => {
    uploads = [];
    // Each Immich upload waits until the test releases it, so the pending state is observable.
    let open;
    release = new Promise((r) => {
      open = r;
    });
    release.open = open;
    store = openStore(':memory:');
    const immich = {
      async uploadAsset(file) {
        uploads.push({ ...file, bytes: await fs.readFile(file.filePath) });
        await release;
        return { status: 'created', id: ASSET_ID };
      },
    };
    // The importer needs the staging dir, which startServer creates; wire it lazily.
    const deps = {
      store,
      importer: {
        enqueue: (id) => importer.enqueue(id),
      },
    };
    srv = await startServer({}, deps);
    importer = createImporter({
      store,
      immich,
      dir: path.join(srv.stagingDir, IMPORT_DIR_NAME),
      failedDir: path.join(srv.stagingDir, FAILED_DIR_NAME),
      retryDelaysMs: [5],
    });
  });

  afterEach(async () => {
    release.open();
    await importer.idle();
    importer.stop();
    store.close();
    await srv.close();
  });

  it('reports import mode in the session', async () => {
    const { cookie } = await login(srv.baseUrl);
    const res = await fetch(`${srv.baseUrl}/api/session`, { headers: { Cookie: cookie } });
    expect(await res.json()).toMatchObject({ authenticated: true, importing: true });
  });

  it('hands a finished upload to Immich with the session identity, then cleans up', async () => {
    const { cookie } = await login(srv.baseUrl, undefined, 'たろう');
    // Client-sent identity metadata must be ignored.
    const result = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0001.png', {
      nickname: 'なりすまし',
      deviceId: 'forged-device',
    });
    expect(result.ok).toBe(true);

    const row = store.get(result.id);
    expect(row).toMatchObject({
      nickname: 'たろう',
      filename: 'IMG_0001.png',
      mime: 'image/png',
      size: PNG.length,
      last_modified: 1_790_000_000_000,
    });
    expect(row.device_id).not.toBe('forged-device');

    const status = async (c) =>
      (await (await fetch(`${srv.baseUrl}/api/uploads`, { headers: { Cookie: c } })).json())
        .uploads;
    await expect.poll(() => uploads.length).toBe(1);
    expect(uploads[0].bytes.equals(PNG)).toBe(true);
    expect(await status(cookie)).toEqual([
      { id: result.id, filename: 'IMG_0001.png', status: 'pending' },
    ]);

    // Another guest never sees this upload.
    const other = await login(srv.baseUrl, undefined, 'はなこ');
    expect(await status(other.cookie)).toEqual([]);

    release.open();
    await importer.idle();
    expect(await status(cookie)).toEqual([
      { id: result.id, filename: 'IMG_0001.png', status: 'created' },
    ]);
    expect(store.get(result.id).asset_id).toBe(ASSET_ID);
    expect(await fs.readdir(path.join(srv.stagingDir, IMPORT_DIR_NAME))).toEqual([]);
  });

  it('answers status queries by id, only for the caller, and validates the ids', async () => {
    const mine = await login(srv.baseUrl);
    const other = await login(srv.baseUrl, undefined, 'はなこ');
    const a = await tusUpload(srv.baseUrl, mine.cookie, PNG, 'IMG_A.png');
    const b = await tusUpload(srv.baseUrl, other.cookie, PNG, 'IMG_B.png');
    const query = async (cookie, qs) => {
      const res = await fetch(`${srv.baseUrl}/api/uploads?${qs}`, { headers: { Cookie: cookie } });
      return { status: res.status, body: await res.json() };
    };

    expect(await query(mine.cookie, `ids=${a.id},${b.id}`)).toEqual({
      status: 200,
      body: { uploads: [{ id: a.id, filename: 'IMG_A.png', status: 'pending' }] },
    });
    const tooMany = Array.from({ length: 101 }, (_, i) => `id${i}`).join(',');
    for (const qs of ['ids=', 'ids=../x', `ids=${tooMany}`, 'ids=a&ids=b']) {
      expect((await query(mine.cookie, qs)).status).toBe(400);
    }
  });

  it('keeps files waiting for Immich and given-up files when staging is purged', async () => {
    const { cookie } = await login(srv.baseUrl);
    const result = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0002.png');
    expect(result.ok).toBe(true);
    await fs.writeFile(path.join(srv.stagingDir, 'partial-upload'), 'x');
    await fs.mkdir(path.join(srv.stagingDir, FAILED_DIR_NAME));
    await fs.writeFile(path.join(srv.stagingDir, FAILED_DIR_NAME, 'given-up'), 'x');

    await purgeStaging(srv.stagingDir, { keep: [IMPORT_DIR_NAME] });
    expect((await fs.readdir(srv.stagingDir)).sort()).toEqual([FAILED_DIR_NAME, IMPORT_DIR_NAME]);
    expect(await fs.readdir(path.join(srv.stagingDir, IMPORT_DIR_NAME))).toEqual([result.id]);
    expect(await fs.readdir(path.join(srv.stagingDir, FAILED_DIR_NAME))).toEqual(['given-up']);

    // Speed-test mode passes no keep list: failed/ still stays.
    await purgeStaging(srv.stagingDir);
    expect(await fs.readdir(srv.stagingDir)).toEqual([FAILED_DIR_NAME]);
  });

  it('leaves failed/ alone when tus removes expired uploads', async () => {
    // An abandoned tus upload from three days ago, next to a given-up file.
    const info = {
      id: 'expired1',
      size: 10,
      offset: 0,
      metadata: {},
      creation_date: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
    };
    await fs.writeFile(path.join(srv.stagingDir, 'expired1'), '');
    await fs.writeFile(path.join(srv.stagingDir, 'expired1.json'), JSON.stringify(info));
    await fs.mkdir(path.join(srv.stagingDir, FAILED_DIR_NAME));
    await fs.writeFile(path.join(srv.stagingDir, FAILED_DIR_NAME, 'given-up'), 'x');

    expect(await srv.tusServer.cleanUpExpiredUploads()).toBe(1);
    expect(await fs.readdir(srv.stagingDir)).toEqual([FAILED_DIR_NAME]);
    expect(await fs.readdir(path.join(srv.stagingDir, FAILED_DIR_NAME))).toEqual(['given-up']);
  });
});

describe('import mode when recording fails', () => {
  let srv;
  beforeEach(async () => {
    const store = {
      add() {
        throw new Error('database is locked');
      },
    };
    srv = await startServer({}, { store, importer: { enqueue() {} } });
  });
  afterEach(async () => {
    await srv.close();
  });

  it('fails the upload and leaves no orphan in importing/', async () => {
    const { cookie } = await login(srv.baseUrl);
    const result = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0003.png');
    expect(result).toEqual({ ok: false, status: 500 });
    expect(await fs.readdir(path.join(srv.stagingDir, IMPORT_DIR_NAME))).toEqual([]);
  });
});
