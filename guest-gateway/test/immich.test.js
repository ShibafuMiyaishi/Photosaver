// guest-gateway/test/immich.test.js
// 偽の Immich サーバーで、ヘッダー・リクエスト内容・エラー時に内部情報を漏らさないことを確認する。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createImmichClient, ImmichError, isUuid } from '../src/immich.js';
import { TMP_ROOT } from './helpers/server.js';

const ALBUM = '11111111-2222-4333-8444-555555555555';
const ASSET = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function startFake(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(entry);
      handler(entry, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('isUuid', () => {
  it('accepts UUIDs only', () => {
    expect(isUuid(ASSET)).toBe(true);
    expect(isUuid('../albums')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('createImmichClient', () => {
  let fake;
  let file;

  beforeAll(async () => {
    await fs.mkdir(TMP_ROOT, { recursive: true });
    file = path.join(TMP_ROOT, `${crypto.randomUUID()}.png`);
    await fs.writeFile(file, Buffer.from('fake-image-bytes'));
  });
  afterAll(async () => {
    await fs.rm(file, { force: true });
  });
  afterEach(async () => {
    await fake?.close();
  });

  it('uploads with the share key header and the required multipart fields', async () => {
    fake = await startFake((_req, res) => json(res, 201, { status: 'created', id: ASSET }));
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'share-secret' });
    const result = await client.uploadAsset({
      filePath: file,
      filename: 'IMG_0001.png',
      mime: 'image/png',
      lastModified: Date.UTC(2026, 9, 1),
    });
    expect(result).toEqual({ status: 'created', id: ASSET });
    const [req] = fake.requests;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/assets');
    expect(req.headers['x-immich-share-key']).toBe('share-secret');
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers['x-immich-checksum']).toBeUndefined();
    const body = req.body.toString('latin1');
    expect(body).toContain('name="assetData"; filename="IMG_0001.png"');
    expect(body).toContain('fake-image-bytes');
    expect(body).toContain('2026-10-01T00:00:00.000Z');
    expect(body).toContain('name="filename"');
  });

  it('treats duplicates as success and rejects malformed responses', async () => {
    fake = await startFake((req, res) =>
      req.url === '/api/assets' ? json(res, 200, { status: 'duplicate', id: ASSET }) : null,
    );
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    const upload = { filePath: file, filename: 'a.png', mime: 'image/png' };
    expect(await client.uploadAsset(upload)).toEqual({ status: 'duplicate', id: ASSET });
    await fake.close();

    fake = await startFake((_req, res) => json(res, 201, { status: 'weird', id: 'nope' }));
    const broken = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    await expect(broken.uploadAsset(upload)).rejects.toBeInstanceOf(ImmichError);
  });

  it('falls back to now for missing or non-positive lastModified', async () => {
    fake = await startFake((_req, res) => json(res, 201, { status: 'created', id: ASSET }));
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    for (const lastModified of [null, 0, '', NaN, -5]) {
      await client.uploadAsset({
        filePath: file,
        filename: 'a.png',
        mime: 'image/png',
        lastModified,
      });
    }
    expect(fake.requests).toHaveLength(5);
    const year = String(new Date().getUTCFullYear());
    for (const req of fake.requests) {
      const body = req.body.toString('latin1');
      expect(body).not.toContain('1970-01-01');
      expect(body).toContain(`${year}-`);
    }
  });

  it('maps unreadable upload files to ImmichError without the path', async () => {
    fake = await startFake((_req, res) => json(res, 201, { status: 'created', id: ASSET }));
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    const missing = path.join(TMP_ROOT, `missing-${crypto.randomUUID()}.png`);
    const err = await client
      .uploadAsset({ filePath: missing, filename: 'a.png', mime: 'image/png' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImmichError);
    expect(err.status).toBe(0);
    expect(err.message).not.toContain(missing);
    expect(err.message).not.toMatch(/ENOENT|test-output/);
    expect(fake.requests).toHaveLength(0);
  });

  it('caps uploads with uploadTimeoutMs', async () => {
    // Answers far later than the cap: only the overall upload cap can end the request in time.
    fake = await startFake((_req, res) =>
      setTimeout(() => json(res, 201, { status: 'created', id: ASSET }), 1_500),
    );
    const client = createImmichClient({
      baseUrl: fake.baseUrl,
      shareKey: 'k',
      uploadTimeoutMs: 200,
    });
    const err = await client
      .uploadAsset({ filePath: file, filename: 'a.png', mime: 'image/png' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImmichError);
    expect(err.status).toBe(0);
  });

  it('never leaks Immich error bodies', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('ENOENT /usr/src/app/upload/internal/path secret-token');
    });
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    const err = await client.getAlbum(ALBUM).catch((e) => e);
    expect(err).toBeInstanceOf(ImmichError);
    expect(err.status).toBe(500);
    expect(err.message).not.toMatch(/ENOENT|internal|secret/);
  });

  it('lists album assets with the v3.2 filter body and cursor paging', async () => {
    fake = await startFake((_req, res) =>
      json(res, 200, {
        albums: {},
        assets: { items: [{ id: ASSET }, { id: ALBUM, isTrashed: true }], nextCursor: 'c2' },
      }),
    );
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    const page = await client.listAlbumAssets({ albumId: ALBUM, cursor: 'c1', size: 50 });
    expect(page).toEqual({ items: [{ id: ASSET }], nextCursor: 'c2' });
    const [req] = fake.requests;
    expect(req.url).toBe('/api/search/metadata');
    expect(JSON.parse(req.body.toString())).toEqual({
      filter: { albumIds: { any: [ALBUM] }, trashedAt: { eq: null } },
      orderBy: { field: 'fileCreatedAt', direction: 'desc' },
      size: 50,
      cursor: 'c1',
    });
  });

  it('deletes with the API key, not the share key', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 's', deleteApiKey: 'd' });
    await client.deleteAssets([ASSET]);
    const [req] = fake.requests;
    expect(req.method).toBe('DELETE');
    expect(req.headers['x-api-key']).toBe('d');
    expect(req.headers['x-immich-share-key']).toBeUndefined();
    expect(JSON.parse(req.body.toString())).toEqual({ ids: [ASSET] });
  });

  it('refuses non-UUID ids and missing credentials without calling Immich', async () => {
    fake = await startFake((_req, res) => json(res, 200, {}));
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    await expect(client.getAlbum('../../admin')).rejects.toBeInstanceOf(ImmichError);
    await expect(client.deleteAssets(['not-a-uuid'])).rejects.toBeInstanceOf(ImmichError);
    await expect(client.deleteAssets([ASSET])).rejects.toBeInstanceOf(ImmichError); // no API key
    expect(fake.requests).toHaveLength(0);
  });

  it('maps network failures to ImmichError', async () => {
    const client = createImmichClient({ baseUrl: 'http://127.0.0.1:1', shareKey: 'k' });
    const err = await client.serverVersion().catch((e) => e);
    expect(err).toBeInstanceOf(ImmichError);
    expect(err.status).toBe(0);
  });

  it('fetches media by kind with the share key and forwards valid ranges only for video/original', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/10' });
      res.end('ok');
    });
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'share-key' });
    const res = await client.fetchMedia({ kind: 'video', id: ASSET, range: 'bytes=0-1' });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('ok');
    await client.fetchMedia({ kind: 'thumbnail', id: ASSET, range: 'bytes=0-1' });
    await client.fetchMedia({ kind: 'original', id: ASSET, range: 'bytes=0-1, 5-6' });
    await client.fetchMedia({ kind: 'preview', id: ASSET });

    expect(fake.requests.map((r) => [r.url, r.headers.range])).toEqual([
      [`/api/assets/${ASSET}/video/playback`, 'bytes=0-1'],
      [`/api/assets/${ASSET}/thumbnail?size=thumbnail`, undefined],
      [`/api/assets/${ASSET}/original`, undefined],
      [`/api/assets/${ASSET}/thumbnail?size=preview`, undefined],
    ]);
    expect(fake.requests.every((r) => r.headers['x-immich-share-key'] === 'share-key')).toBe(true);
    expect(fake.requests.every((r) => r.headers.cookie === undefined)).toBe(true);
  });

  it('maps non-200/206 media responses to ImmichError without the body', async () => {
    fake = await startFake((_req, res) => json(res, 400, { message: 'secret internal detail' }));
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    const err = await client.fetchMedia({ kind: 'original', id: ASSET }).catch((e) => e);
    expect(err).toBeInstanceOf(ImmichError);
    expect(err.status).toBe(400);
    expect(err.message).not.toContain('secret');
  });

  it('limits only the wait for media headers, not the body transfer', async () => {
    fake = await startFake((req, res) => {
      if (req.url.includes('thumbnail')) return setTimeout(() => res.end('late'), 200);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write('a');
      return setTimeout(() => res.end('b'), 200);
    });
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k', timeoutMs: 50 });
    const slowHeaders = await client.fetchMedia({ kind: 'thumbnail', id: ASSET }).catch((e) => e);
    expect(slowHeaders).toBeInstanceOf(ImmichError);
    const slowBody = await client.fetchMedia({ kind: 'original', id: ASSET });
    expect(await slowBody.text()).toBe('ab');
  });

  it('aborts a media transfer when the caller signal fires', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.write('first');
    });
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    const controller = new AbortController();
    const res = await client.fetchMedia({ kind: 'video', id: ASSET, signal: controller.signal });
    const reading = res.text();
    controller.abort();
    await expect(reading).rejects.toThrow();
  });

  it('refuses unknown media kinds and non-UUID ids without calling Immich', async () => {
    fake = await startFake((_req, res) => res.end());
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    for (const request of [
      { kind: 'fullsize', id: ASSET },
      { kind: '__proto__', id: ASSET },
      { kind: 'original', id: '../../server/config' },
    ]) {
      await expect(client.fetchMedia(request)).rejects.toBeInstanceOf(ImmichError);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('forwards only well-formed single ranges and relays 416 with its Content-Range', async () => {
    fake = await startFake((req, res) => {
      if (req.headers.range === 'bytes=999-') {
        res.writeHead(416, { 'content-range': 'bytes */10' });
        return res.end();
      }
      return res.end('x');
    });
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    for (const range of ['bytes=-', 'bytes=-500', 'bytes=0-', 'bytes=1-2-3']) {
      await client.fetchMedia({ kind: 'original', id: ASSET, range });
    }
    expect(fake.requests.map((r) => r.headers.range)).toEqual([
      undefined,
      'bytes=-500',
      'bytes=0-',
      undefined,
    ]);
    const res = await client.fetchMedia({ kind: 'video', id: ASSET, range: 'bytes=999-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('lists in ascending order on request', async () => {
    fake = await startFake((_req, res) =>
      json(res, 200, { assets: { items: [], nextCursor: null } }),
    );
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'k' });
    await client.listAlbumAssets({ albumId: ALBUM, direction: 'asc' });
    await client.listAlbumAssets({ albumId: ALBUM, direction: 'sideways' });
    const bodies = fake.requests.map((r) => JSON.parse(r.body).orderBy.direction);
    expect(bodies).toEqual(['asc', 'desc']);
  });
  it('plans ZIP archives through the share link and keeps only valid ids', async () => {
    fake = await startFake((_req, res) =>
      json(res, 201, {
        totalSize: 999,
        archives: [
          { size: 10, assetIds: [ASSET, '../etc/passwd'] },
          { size: 5, assetIds: ['nope'] },
        ],
      }),
    );
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'share-key' });
    const info = await client.downloadInfo({ albumId: ALBUM, archiveSize: 2048 });
    // Parts that end up empty are dropped; the total is recomputed from what is kept.
    expect(info).toEqual({ totalSize: 10, archives: [{ size: 10, assetIds: [ASSET] }] });
    const [req] = fake.requests;
    expect([req.method, req.url, req.headers['x-immich-share-key']]).toEqual([
      'POST',
      '/api/download/info',
      'share-key',
    ]);
    expect(JSON.parse(req.body)).toEqual({ albumId: ALBUM, archiveSize: 2048 });
    await expect(client.downloadInfo({ albumId: 'x', archiveSize: 1 })).rejects.toBeInstanceOf(
      ImmichError,
    );
  });

  it('opens a ZIP stream uncompressed and maps rejections without the body', async () => {
    fake = await startFake((req, res) => {
      if (JSON.parse(req.body).assetIds.length > 1) return json(res, 400, { message: 'internal' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end('PK');
    });
    const client = createImmichClient({ baseUrl: fake.baseUrl, shareKey: 'share-key' });
    const res = await client.downloadArchive({ assetIds: [ASSET] });
    expect(await res.text()).toBe('PK');
    const [req] = fake.requests;
    expect([req.method, req.url]).toEqual(['POST', '/api/download/archive']);
    expect(req.headers['accept-encoding']).toBe('identity');
    expect(req.headers['x-immich-share-key']).toBe('share-key');
    expect(JSON.parse(req.body)).toEqual({ assetIds: [ASSET] });

    const err = await client.downloadArchive({ assetIds: [ASSET, ALBUM] }).catch((e) => e);
    expect(err).toBeInstanceOf(ImmichError);
    expect(err.status).toBe(400);
    expect(err.message).not.toContain('internal');
    // An already-cancelled request never reaches Immich.
    const before = fake.requests.length;
    await expect(
      client.downloadArchive({ assetIds: [ASSET], signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(ImmichError);
    expect(fake.requests.length).toBe(before);
    for (const assetIds of [[], ['nope'], undefined]) {
      await expect(client.downloadArchive({ assetIds })).rejects.toBeInstanceOf(ImmichError);
    }
  });
});
