// guest-gateway/test/download.test.js
// PC 向けの ZIP 一括ダウンロード: 分割計画は端末ごと、ZIP はその時点でアルバムにある写真だけ
// (ゴミ箱の写真が混じると Immich が ZIP 全体を拒否するため)、同時数の上限、エラーは読めるページ。

import { ImmichError } from '../src/immich.js';
import { openStore } from '../src/store.js';
import { login, PASSWORD, startServer } from './helpers/server.js';

const ALBUM = '11111111-2222-4333-8444-555555555555';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const MOTION = 'aaaaaaaa-0000-4000-8000-000000000003';
const C = 'aaaaaaaa-0000-4000-8000-000000000004';
const CSRF = { 'X-Requested-With': 'guest-gateway' };

function fakeImmich() {
  return {
    listed: [
      { id: A, type: 'IMAGE', fileCreatedAt: '2026-10-10T03:00:00.000Z', livePhotoVideoId: MOTION },
      { id: B, type: 'IMAGE', fileCreatedAt: '2026-10-10T02:00:00.000Z' },
      { id: C, type: 'VIDEO', fileCreatedAt: '2026-10-10T01:00:00.000Z' },
    ],
    archives: [
      { size: 300, assetIds: [A, B, MOTION] },
      { size: 900, assetIds: [C] },
    ],
    infoError: null,
    archiveError: null,
    archiveCalls: [],
    // When set, archive bodies stay open until released (for the concurrency limit).
    hold: false,
    releases: [],
    async getAlbum() {
      return { assetCount: this.listed.length };
    },
    async listAlbumAssets() {
      return { items: this.listed, nextCursor: null };
    },
    async downloadInfo({ albumId, archiveSize }) {
      if (this.infoError) throw this.infoError;
      expect(albumId).toBe(ALBUM);
      expect(archiveSize).toBeGreaterThan(0);
      return {
        totalSize: this.archives.reduce((sum, a) => sum + a.size, 0),
        archives: this.archives,
      };
    },
    async downloadArchive({ assetIds }) {
      if (this.archiveError) throw this.archiveError;
      this.archiveCalls.push(assetIds);
      const hold = this.hold;
      const releases = this.releases;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`PK zip of ${assetIds.join(',')}`));
          if (hold) releases.push(() => controller.close());
          else controller.close();
        },
      });
      return new Response(body, { status: 200 });
    },
  };
}

async function setup() {
  const store = openStore(':memory:');
  const immich = fakeImmich();
  const srv = await startServer(
    { immich: { albumId: ALBUM } },
    { store, importer: { enqueue() {} }, immich },
  );
  const cookie = (await login(srv.baseUrl, PASSWORD, 'たろう')).cookie;
  return { srv, store, immich, cookie };
}

function plan(ctx, cookie = ctx.cookie, headers = CSRF) {
  return fetch(`${ctx.srv.baseUrl}/api/download`, {
    method: 'POST',
    headers: { Cookie: cookie, ...headers },
  });
}

function part(ctx, id, n, cookie = ctx.cookie, method = 'GET') {
  return fetch(`${ctx.srv.baseUrl}/download/${id}/${n}`, { method, headers: { Cookie: cookie } });
}

describe('ZIP download', () => {
  let ctx;
  afterEach(async () => {
    for (const release of ctx.immich.releases) release();
    await ctx.srv.close();
    ctx.store.close();
  });

  it('plans the parts and streams each ZIP as an attachment', async () => {
    ctx = await setup();
    const res = await plan(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      totalSize: 1200,
      parts: [
        { size: 300, count: 3 },
        { size: 900, count: 1 },
      ],
    });

    const zip = await part(ctx, body.id, 1);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toBe('attachment; filename="photos-1-of-2.zip"');
    expect(zip.headers.get('cache-control')).toBe('private, no-store');
    expect(await zip.text()).toBe(`PK zip of ${A},${B},${MOTION}`);
  });

  it('names a single ZIP photos.zip', async () => {
    ctx = await setup();
    ctx.immich.archives = [{ size: 10, assetIds: [A] }];
    const { id } = await (await plan(ctx)).json();
    const zip = await part(ctx, id, 1);
    expect(zip.headers.get('content-disposition')).toBe('attachment; filename="photos.zip"');
    await zip.text();
  });

  it('leaves out assets deleted since the plan, keeping live-photo motion parts', async () => {
    ctx = await setup();
    const { id } = await (await plan(ctx)).json();
    // B went to the trash after the plan was made (the album is listed when the ZIP is asked for).
    ctx.immich.listed = ctx.immich.listed.filter((a) => a.id !== B);
    const zip = await part(ctx, id, 1);
    expect(await zip.text()).toBe(`PK zip of ${A},${MOTION}`);
    expect(ctx.immich.archiveCalls).toEqual([[A, MOTION]]);
  });

  it('says so when every asset of a part is gone', async () => {
    ctx = await setup();
    ctx.immich.listed = ctx.immich.listed.filter((a) => a.id !== C);
    const { id } = await (await plan(ctx)).json();
    const res = await part(ctx, id, 2);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain('すべて削除');
    expect(ctx.immich.archiveCalls).toEqual([]);
  });

  it('keeps plans per device and replaces the previous one', async () => {
    ctx = await setup();
    const first = await (await plan(ctx)).json();
    const second = await (await plan(ctx)).json();
    expect((await part(ctx, first.id, 1)).status).toBe(404);
    const other = (await login(ctx.srv.baseUrl, PASSWORD, 'はなこ')).cookie;
    const res = await part(ctx, second.id, 1, other);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('もう一度「ZIP を作成」');
    // Unknown part numbers and malformed ids.
    expect((await part(ctx, second.id, 3)).status).toBe(404);
    expect((await part(ctx, 'nothex', 1)).status).toBe(404);
    expect(ctx.immich.archiveCalls).toEqual([]);
  });

  it('requires a session (readable page for the link) and the CSRF header for planning', async () => {
    ctx = await setup();
    const { id } = await (await plan(ctx)).json();
    const res = await part(ctx, id, 1, '');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('ログインし直して');
    expect((await plan(ctx, ctx.cookie, {})).status).toBe(403);
    expect((await plan(ctx, '')).status).toBe(401);
  });

  it('limits parallel ZIPs per device', async () => {
    ctx = await setup();
    ctx.immich.hold = true;
    const { id } = await (await plan(ctx)).json();
    const first = await part(ctx, id, 1);
    const second = await part(ctx, id, 2);
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await part(ctx, id, 1);
    expect(third.status).toBe(429);
    expect(await third.text()).toContain('混み合って');
    for (const release of ctx.immich.releases.splice(0)) release();
    await first.text();
    await second.text();
    // Slots come back once the streams end.
    await new Promise((r) => setTimeout(r, 20));
    ctx.immich.hold = false;
    expect((await part(ctx, id, 1)).status).toBe(200);
  });

  it('answers HEAD without building a ZIP', async () => {
    ctx = await setup();
    const { id } = await (await plan(ctx)).json();
    const res = await part(ctx, id, 1, ctx.cookie, 'HEAD');
    expect(res.status).toBe(200);
    expect(ctx.immich.archiveCalls).toEqual([]);
  });

  it('maps Immich failures', async () => {
    ctx = await setup();
    ctx.immich.infoError = new ImmichError('download_info', 503);
    expect((await plan(ctx)).status).toBe(502);
    ctx.immich.infoError = null;
    const { id } = await (await plan(ctx)).json();
    ctx.immich.archiveError = new ImmichError('archive', 400);
    const res = await part(ctx, id, 1);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('ZIP を作成できませんでした');
  });
});
