// guest-gateway/test/gallery.test.js
// ギャラリー中継の受入テスト: ログイン必須、一覧は必要な項目だけ、メディアはヘッダーを絞って中継、
// 想定外や Immich のエラーは 404、ゲストが切断したら Immich 側も止める。Immich は偽クライアント。

import http from 'node:http';
import { ImmichError } from '../src/immich.js';
import { openStore } from '../src/store.js';
import { login, startServer } from './helpers/server.js';

const ALBUM = '11111111-2222-4333-8444-555555555555';
const A1 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const A2 = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
const A3 = '88888888-9999-4aaa-bbbb-cccccccccccc';

const IMMICH_ITEMS = [
  {
    id: A1,
    type: 'IMAGE',
    width: 4032,
    height: 3024,
    fileCreatedAt: '2026-10-10T03:00:00.000Z',
    duration: null,
    thumbhash: 'abc',
    originalFileName: 'IMG_0001.HEIC',
    originalPath: '/data/upload/secret/path.heic',
    ownerId: 'owner-uuid',
    checksum: 'xyz',
  },
  {
    id: A2,
    type: 'VIDEO',
    width: 1920,
    height: 1080,
    fileCreatedAt: '2026-10-10T02:00:00.000Z',
    duration: 3000,
    thumbhash: null,
    originalFileName: 'IMG_0002.MOV',
  },
  { id: A3, type: 'IMAGE', originalFileName: 'from-immich-app.jpg' },
];

function fakeImmich() {
  const calls = { list: [], media: [] };
  return {
    calls,
    // Pages keyed by cursor (null = first page).
    pages: new Map([[null, { items: IMMICH_ITEMS, nextCursor: null }]]),
    listError: null,
    media: null,
    async listAlbumAssets(query) {
      calls.list.push(query);
      if (this.listError) throw this.listError;
      return this.pages.get(query.cursor);
    },
    async fetchMedia(request) {
      calls.media.push(request);
      return this.media(request);
    },
  };
}

describe('gallery relay', () => {
  let srv;
  let store;
  let immich;
  let cookie;

  beforeEach(async () => {
    store = openStore(':memory:');
    immich = fakeImmich();
    srv = await startServer(
      { immich: { albumId: ALBUM } },
      { store, importer: { enqueue() {} }, immich },
    );
    cookie = (await login(srv.baseUrl, undefined, 'たろう')).cookie;
  });
  afterEach(async () => {
    await srv.close();
    store.close();
  });

  const get = (path, headers = {}) =>
    fetch(`${srv.baseUrl}${path}`, { headers: { Cookie: cookie, ...headers } });

  it('requires a session and reports the gallery in the session', async () => {
    expect((await fetch(`${srv.baseUrl}/api/assets`)).status).toBe(401);
    expect((await fetch(`${srv.baseUrl}/media/${A1}/thumbnail`)).status).toBe(401);
    expect(await (await get('/api/session')).json()).toMatchObject({ gallery: true });
  });

  it('lists only guest-safe fields with uploader nicknames and ownership', async () => {
    // A1 was uploaded from this device, A2 by another guest; A3 came from the Immich app.
    const me = (await (await get('/api/session')).json()).nickname;
    expect(me).toBe('たろう');
    const deviceOf = (c) =>
      JSON.parse(Buffer.from(c.split('=')[1].split('.')[0], 'base64url')).deviceId;
    const row = { filename: 'x', mime: 'image/jpeg', size: 1, lastModified: null };
    store.add({ ...row, uploadId: 'u1', deviceId: deviceOf(cookie), nickname: 'たろう' });
    store.markImported('u1', 'created', A1);
    store.add({ ...row, uploadId: 'u2', deviceId: 'other', nickname: 'はなこ' });
    store.markImported('u2', 'created', A2);
    // A duplicate upload of A2 from this device does not make it ours.
    store.add({ ...row, uploadId: 'u3', deviceId: deviceOf(cookie), nickname: 'たろう' });
    store.markImported('u3', 'duplicate', A2);

    const res = await get('/api/assets');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({
      assets: [
        {
          id: A1,
          type: 'image',
          width: 4032,
          height: 3024,
          takenAt: '2026-10-10T03:00:00.000Z',
          durationMs: null,
          thumbhash: 'abc',
          filename: 'IMG_0001.HEIC',
          by: 'たろう',
          mine: true,
        },
        {
          id: A2,
          type: 'video',
          width: 1920,
          height: 1080,
          takenAt: '2026-10-10T02:00:00.000Z',
          durationMs: 3000,
          thumbhash: null,
          filename: 'IMG_0002.MOV',
          by: 'はなこ',
          mine: false,
        },
        {
          id: A3,
          type: 'image',
          width: null,
          height: null,
          takenAt: null,
          durationMs: null,
          thumbhash: null,
          filename: 'from-immich-app.jpg',
          by: null,
          mine: false,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(immich.calls.list).toEqual([{ albumId: ALBUM, cursor: null, size: 1000 }]);
  });

  it('merges all pages, drops duplicates across page boundaries and sorts stably', async () => {
    const at = (id, time) => ({ id, type: 'IMAGE', fileCreatedAt: time });
    const same = '2026-10-10T03:00:00.000Z';
    // Immich's unstable offset paging returns A2 on both pages.
    immich.pages = new Map([
      [null, { items: [at(A2, same), at(A1, same)], nextCursor: 'c1' }],
      ['c1', { items: [at(A2, same), at(A3, '2026-10-10T04:00:00.000Z')], nextCursor: null }],
    ]);
    const { assets } = await (await get('/api/assets')).json();
    expect(assets.map((a) => a.id)).toEqual([A3, A2, A1]);
    expect(immich.calls.list.map((c) => c.cursor)).toEqual([null, 'c1']);
  });

  it('shares one listing between requests for a few seconds', async () => {
    await Promise.all([get('/api/assets'), get('/api/assets'), get('/api/assets')]);
    await get('/api/assets');
    expect(immich.calls.list).toHaveLength(1);
  });

  it('hides Immich failures and does not cache them', async () => {
    immich.listError = new ImmichError('list', 500);
    const failed = await get('/api/assets');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'unavailable' });
    immich.listError = null;
    expect((await get('/api/assets')).status).toBe(200);
  });

  it('relays media with an allowlist of headers and a private cache policy', async () => {
    immich.media = () =>
      new Response('webp-bytes', {
        status: 200,
        headers: {
          'content-type': 'image/webp',
          'content-length': '10',
          'set-cookie': 'immich_session=leak',
          'x-immich-internal': 'leak',
          'content-disposition': "inline; filename*=UTF-8''IMG_0001_thumbnail.webp",
        },
      });
    const res = await get(`/media/${A1}/thumbnail`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('webp-bytes');
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-immich-internal')).toBeNull();
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(immich.calls.media).toEqual([
      expect.objectContaining({ kind: 'thumbnail', id: A1, range: undefined }),
    ]);
  });

  it('forwards Range for video and relays partial content', async () => {
    immich.media = () =>
      new Response('0123456789', {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-9/100',
          'accept-ranges': 'bytes',
        },
      });
    const res = await get(`/media/${A2}/video`, { Range: 'bytes=0-9' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('0123456789');
    expect(immich.calls.media[0]).toMatchObject({ kind: 'video', range: 'bytes=0-9' });
  });

  it('serves originals as attachments only with ?download=1 and only reuses safe filenames', async () => {
    let disposition = "inline; filename*=UTF-8''IMG_0001%20(1).HEIC";
    immich.media = () => new Response('x', { headers: { 'content-disposition': disposition } });
    expect((await get(`/media/${A1}/original`)).headers.get('content-disposition')).toBeNull();
    expect((await get(`/media/${A1}/original?download=1`)).headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''IMG_0001%20(1).HEIC",
    );
    // Not the exact filename* shape (quotes could break out of the header parameter).
    disposition = 'inline; filename="evil.html"; filename*=UTF-8\'\'a%22b';
    expect((await get(`/media/${A1}/original?download=1`)).headers.get('content-disposition')).toBe(
      'attachment',
    );
  });

  it('answers 404 for unknown shapes and Immich 4xx, 416 for bad ranges, 502 otherwise', async () => {
    immich.media = () => new Response('x');
    for (const path of [
      '/media/not-a-uuid/thumbnail',
      `/media/${A1}/fullsize`,
      `/media/${A1}/__proto__`,
      `/media/${A1}`,
    ]) {
      expect((await get(path)).status).toBe(404);
    }
    expect(immich.calls.media).toHaveLength(0);

    immich.media = () => {
      throw new ImmichError('media', 400);
    };
    const notInAlbum = await get(`/media/${A1}/preview`);
    expect(notInAlbum.status).toBe(404);
    expect(await notInAlbum.json()).toEqual({ error: 'not_found' });

    immich.media = () => {
      throw new ImmichError('media', 416);
    };
    expect((await get(`/media/${A2}/video`, { Range: 'bytes=999-' })).status).toBe(416);

    immich.media = () => {
      throw new ImmichError('media', 0);
    };
    expect((await get(`/media/${A1}/preview`)).status).toBe(502);
  });

  it('aborts the upstream transfer when the guest disconnects', async () => {
    let upstreamSignal;
    immich.media = ({ signal }) => {
      upstreamSignal = signal;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first chunk'));
          // Never closes: a long video download.
        },
      });
      return new Response(body, { headers: { 'content-type': 'video/mp4' } });
    };
    const { hostname, port } = new URL(srv.baseUrl);
    await new Promise((resolve) => {
      const req = http.get(
        {
          hostname,
          port,
          path: `/media/${A2}/original`,
          headers: { Cookie: cookie },
          agent: false,
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => {});
    });
    await expect.poll(() => upstreamSignal?.aborted).toBe(true);
  });
});

describe('gallery in speed-test mode', () => {
  let srv;
  beforeEach(async () => {
    srv = await startServer();
  });
  afterEach(async () => {
    await srv.close();
  });

  it('does not expose gallery routes', async () => {
    const { cookie } = await login(srv.baseUrl);
    const headers = { Cookie: cookie };
    expect((await fetch(`${srv.baseUrl}/api/assets`, { headers })).status).toBe(404);
    expect((await fetch(`${srv.baseUrl}/media/${A1}/thumbnail`, { headers })).status).toBe(404);
    const session = await (await fetch(`${srv.baseUrl}/api/session`, { headers })).json();
    expect(session.gallery).toBe(false);
  });
});
