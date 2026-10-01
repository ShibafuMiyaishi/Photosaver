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
});
