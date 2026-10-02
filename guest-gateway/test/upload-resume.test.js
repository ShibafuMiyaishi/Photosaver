// guest-gateway/test/upload-resume.test.js
// 受信の再開まわり: 受信途中のアップロードは開始した端末だけが再開できること、受信済みへの再開確認に
// 「完了」と答えること、起動時の拾い直し、拡張子の補正、受信途中の残り容量を差し引く空き容量検査。

import fs from 'node:fs/promises';
import path from 'node:path';
import * as tus from 'tus-js-client';
import { openStore } from '../src/store.js';
import { IMPORT_DIR_NAME, KEPT_DIR_NAME } from '../src/uploads.js';
import { login, startServer, TMP_ROOT } from './helpers/server.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// Smallest header file-type recognises as MP4 (ftyp box, brand isom).
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from('isomiso2'),
  Buffer.alloc(64),
]);
const CSRF = { 'X-Requested-With': 'guest-gateway' };
const GIB = 1024 ** 3;

function encodeMetadata(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');
}

async function createRaw(baseUrl, cookie, size, filename = 'IMG_0001.png') {
  const res = await fetch(`${baseUrl}/files/`, {
    method: 'POST',
    headers: {
      ...CSRF,
      Cookie: cookie,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': encodeMetadata({ filename, lastModified: '1790000000000' }),
    },
  });
  const location = res.headers.get('location');
  return { status: res.status, location, id: location?.split('/').pop() };
}

function patch(baseUrl, cookie, location, offset, bytes) {
  return fetch(new URL(location, baseUrl), {
    method: 'PATCH',
    headers: {
      ...CSRF,
      Cookie: cookie,
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
    },
    body: bytes,
  });
}

function head(baseUrl, cookie, location) {
  return fetch(new URL(location, baseUrl), {
    method: 'HEAD',
    headers: { ...CSRF, Cookie: cookie, 'Tus-Resumable': '1.0.0' },
  });
}

/** tus-js-client, optionally resuming a known upload URL; counts the requests it sends. */
function tusUpload(baseUrl, cookie, data, filename, { uploadUrl } = {}) {
  const methods = [];
  return new Promise((resolve) => {
    const upload = new tus.Upload(data, {
      endpoint: `${baseUrl}/files/`,
      uploadUrl,
      headers: { ...CSRF, Cookie: cookie },
      metadata: { filename, filetype: 'image/png', lastModified: '1790000000000' },
      uploadSize: data.length,
      retryDelays: [],
      onBeforeRequest: (req) => methods.push(req.getMethod()),
      onSuccess: () =>
        resolve({ ok: true, id: new URL(upload.url, baseUrl).pathname.split('/').pop(), methods }),
      onError: (err) => resolve({ ok: false, status: err.originalResponse?.getStatus(), methods }),
    });
    upload.start();
  });
}

const exists = (filePath) =>
  fs.stat(filePath).then(
    () => true,
    () => false,
  );

describe('upload resume (import mode)', () => {
  let srv;
  let store;
  let enqueued;

  beforeEach(async () => {
    store = openStore(':memory:');
    enqueued = [];
    srv = await startServer({}, { store, importer: { enqueue: (id) => enqueued.push(id) } });
  });

  afterEach(async () => {
    store.close();
    await srv.close();
  });

  it('hides an unfinished upload from other devices (HEAD and PATCH → the same 404)', async () => {
    const owner = await login(srv.baseUrl);
    const other = await login(srv.baseUrl, undefined, 'はなこ');
    const created = await createRaw(srv.baseUrl, owner.cookie, PNG.length);
    expect(created.status).toBe(201);
    expect(
      (await patch(srv.baseUrl, owner.cookie, created.location, 0, PNG.subarray(0, 10))).status,
    ).toBe(204);

    const own = await head(srv.baseUrl, owner.cookie, created.location);
    expect(own.status).toBe(200);
    expect(own.headers.get('upload-offset')).toBe('10');

    const missing = await head(srv.baseUrl, other.cookie, '/files/0123456789abcdef');
    const foreign = await head(srv.baseUrl, other.cookie, created.location);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const foreignPatch = await patch(
      srv.baseUrl,
      other.cookie,
      created.location,
      10,
      PNG.subarray(10),
    );
    const missingPatch = await patch(
      srv.baseUrl,
      other.cookie,
      '/files/0123456789abcdef',
      10,
      PNG.subarray(10),
    );
    expect(foreignPatch.status).toBe(404);
    expect(await foreignPatch.text()).toBe(await missingPatch.text());
    // The foreign PATCH wrote nothing.
    expect(
      (await head(srv.baseUrl, owner.cookie, created.location)).headers.get('upload-offset'),
    ).toBe('10');
  });

  it('restarts a resumed upload as a fresh one for the new device after a re-login', async () => {
    const before = await login(srv.baseUrl);
    const created = await createRaw(srv.baseUrl, before.cookie, PNG.length);
    await patch(srv.baseUrl, before.cookie, created.location, 0, PNG.subarray(0, 10));

    // Same browser, new login → new deviceId; tus-js-client still knows the old URL.
    const after = await login(srv.baseUrl);
    const result = await tusUpload(srv.baseUrl, after.cookie, PNG, 'IMG_0001.png', {
      uploadUrl: new URL(created.location, srv.baseUrl).href,
    });
    // HEAD 404 → tus-js-client forgets the URL and creates a new upload.
    expect(result.ok).toBe(true);
    expect(result.methods).toEqual(['HEAD', 'POST', 'PATCH']);
    expect(result.id).not.toBe(created.id);

    const mine = await (
      await fetch(`${srv.baseUrl}/api/uploads`, { headers: { Cookie: after.cookie } })
    ).json();
    expect(mine.uploads).toEqual([{ id: result.id, filename: 'IMG_0001.png', status: 'pending' }]);
    // The old device's partial upload is left alone (tus expiry removes it).
    expect(await exists(path.join(srv.stagingDir, created.id))).toBe(true);
  });

  it('answers a finished upload as complete to its device only, so nothing is re-sent', async () => {
    const { cookie } = await login(srv.baseUrl);
    const first = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0002.png');
    expect(first.ok).toBe(true);
    const location = `/files/${first.id}`;

    // The PATCH's response was lost: tus-js-client retries with a HEAD.
    const res = await head(srv.baseUrl, cookie, location);
    expect(res.status).toBe(200);
    expect(res.headers.get('tus-resumable')).toBe('1.0.0');
    expect(res.headers.get('upload-offset')).toBe(String(PNG.length));
    expect(res.headers.get('upload-length')).toBe(String(PNG.length));
    expect(res.headers.get('cache-control')).toBe('no-store');

    const resumed = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0002.png', {
      uploadUrl: new URL(location, srv.baseUrl).href,
    });
    expect(resumed).toMatchObject({ ok: true, id: first.id, methods: ['HEAD'] });
    expect(enqueued).toEqual([first.id]);

    const other = await login(srv.baseUrl, undefined, 'はなこ');
    expect((await head(srv.baseUrl, other.cookie, location)).status).toBe(404);
    // Without Tus-Resumable it stays a tus protocol error.
    const bare = await fetch(new URL(location, srv.baseUrl), {
      method: 'HEAD',
      headers: { Cookie: cookie },
    });
    expect(bare.status).toBe(412);
  });

  it('sends Immich a name whose extension matches the content', async () => {
    const { cookie } = await login(srv.baseUrl);
    const mp4AsPng = await tusUpload(srv.baseUrl, cookie, MP4, 'clip.PNG');
    const pngAsJpg = await tusUpload(srv.baseUrl, cookie, PNG, 'LINE_photo.jpg');
    const honest = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0003.png');
    expect(store.get(mp4AsPng.id)).toMatchObject({ filename: 'clip.mp4', mime: 'video/mp4' });
    expect(store.get(pngAsJpg.id)).toMatchObject({ filename: 'LINE_photo.png', mime: 'image/png' });
    expect(store.get(honest.id)).toMatchObject({ filename: 'IMG_0003.png' });
  });

  describe('startup reconcile', () => {
    async function stage(id, { data, size = data.length, metadata = {} }) {
      const info = {
        id,
        size,
        offset: 0,
        metadata: { filename: 'IMG_0009.png', deviceId: 'dev-1', nickname: 'たろう', ...metadata },
        creation_date: new Date().toISOString(),
      };
      await fs.writeFile(path.join(srv.stagingDir, `${id}.json`), JSON.stringify(info));
      if (data) await fs.writeFile(path.join(srv.stagingDir, id), data);
    }

    it('finishes complete uploads, leaves incomplete ones, and is idempotent', async () => {
      await stage('complete1', { data: PNG });
      await stage('partial1', { data: PNG.subarray(0, 10), size: PNG.length });

      expect(await srv.tusServer.reconcile()).toBe(1);
      expect(store.get('complete1')).toMatchObject({
        device_id: 'dev-1',
        nickname: 'たろう',
        filename: 'IMG_0009.png',
        mime: 'image/png',
        size: PNG.length,
        status: 'pending',
      });
      expect(enqueued).toEqual(['complete1']);
      expect(await exists(path.join(srv.stagingDir, IMPORT_DIR_NAME, 'complete1'))).toBe(true);
      expect(await exists(path.join(srv.stagingDir, 'complete1.json'))).toBe(false);
      expect(await exists(path.join(srv.stagingDir, 'partial1'))).toBe(true);
      expect(await exists(path.join(srv.stagingDir, 'partial1.json'))).toBe(true);

      expect(await srv.tusServer.reconcile()).toBe(0);
      expect(enqueued).toEqual(['complete1']);
    });

    it('records a file already moved to importing/ whose info file was left behind', async () => {
      await stage('moved1', { size: PNG.length });
      await fs.mkdir(path.join(srv.stagingDir, IMPORT_DIR_NAME), { recursive: true });
      await fs.writeFile(path.join(srv.stagingDir, IMPORT_DIR_NAME, 'moved1'), PNG);
      // Already recorded: only the info file goes.
      await stage('moved2', { size: PNG.length });
      await fs.writeFile(path.join(srv.stagingDir, IMPORT_DIR_NAME, 'moved2'), PNG);
      store.add({
        uploadId: 'moved2',
        deviceId: 'dev-2',
        nickname: 'じろう',
        filename: 'x.png',
        mime: 'image/png',
        size: PNG.length,
        lastModified: null,
      });

      expect(await srv.tusServer.reconcile()).toBe(1);
      expect(store.get('moved1')).toMatchObject({ device_id: 'dev-1', status: 'pending' });
      expect(store.get('moved2')).toMatchObject({ device_id: 'dev-2' });
      expect(enqueued).toEqual(['moved1']);
      expect((await fs.readdir(srv.stagingDir)).filter((n) => n.endsWith('.json'))).toEqual([]);
    });

    it('drops complete uploads whose content is not allowed', async () => {
      await stage('bad1', { data: Buffer.from('%PDF-1.7\n'.repeat(20)) });
      expect(await srv.tusServer.reconcile()).toBe(0);
      expect(store.get('bad1')).toBeUndefined();
      expect(await exists(path.join(srv.stagingDir, 'bad1'))).toBe(false);
    });
  });
});

describe('startup reconcile (speed-test mode)', () => {
  let srv;
  afterEach(async () => {
    await srv.close();
  });

  it('keeps a complete upload in kept/ with KEEP_UPLOADS', async () => {
    srv = await startServer({ keepUploads: true });
    const info = { id: 'k1', size: PNG.length, offset: 0, metadata: { filename: 'a.jpg' } };
    await fs.writeFile(path.join(srv.stagingDir, 'k1.json'), JSON.stringify(info));
    await fs.writeFile(path.join(srv.stagingDir, 'k1'), PNG);
    await srv.tusServer.reconcile();
    // The extension follows the content here too.
    expect(await fs.readdir(path.join(srv.stagingDir, KEPT_DIR_NAME))).toEqual(['k1.png']);
    expect(await exists(path.join(srv.stagingDir, 'k1.json'))).toBe(false);
  });
});

describe('free space check', () => {
  let srv;
  afterEach(async () => {
    await srv.close();
  });

  // Room for one 1 GiB upload but not two: the second must count the first one's missing bytes.
  async function startTight() {
    await fs.mkdir(TMP_ROOT, { recursive: true });
    const stats = await fs.statfs(TMP_ROOT);
    const free = stats.bavail * stats.bsize;
    srv = await startServer({ minFreeBytes: free - 1.5 * GIB });
  }

  it('subtracts the bytes uploads in progress will still write', async () => {
    await startTight();
    const { cookie } = await login(srv.baseUrl);
    expect((await createRaw(srv.baseUrl, cookie, GIB)).status).toBe(201);
    expect((await createRaw(srv.baseUrl, cookie, GIB)).status).toBe(507);
  });

  it('does not let two simultaneous creates share the same free space', async () => {
    await startTight();
    const { cookie } = await login(srv.baseUrl);
    const results = await Promise.all([
      createRaw(srv.baseUrl, cookie, GIB),
      createRaw(srv.baseUrl, cookie, GIB),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 507]);
  });

  it('counts uploads left in staging by an earlier run (read from disk)', async () => {
    await startTight();
    const info = { id: 'old1', size: GIB, offset: 0, metadata: { filename: 'a.mov' } };
    await fs.writeFile(path.join(srv.stagingDir, 'old1.json'), JSON.stringify(info));
    await fs.writeFile(path.join(srv.stagingDir, 'old1'), '');
    const { cookie } = await login(srv.baseUrl);
    expect((await createRaw(srv.baseUrl, cookie, GIB)).status).toBe(507);
  });
});
