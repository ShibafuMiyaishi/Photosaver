// guest-gateway/test/delete.test.js
// 削除の受入テスト: ゲストは自分の端末から上げて取り込まれたものだけ、管理者合言葉なら全件。
// CSRF・削除キー未設定・Immich のエラーの扱いと、削除後に一覧から消えることを確認する。

import { hashPassword } from '../src/auth.js';
import { ImmichError } from '../src/immich.js';
import { openStore } from '../src/store.js';
import { login, PASSWORD, startServer } from './helpers/server.js';

const ALBUM = '11111111-2222-4333-8444-555555555555';
const MINE = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const THEIRS = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
const ADMIN_PASSWORD = 'organiser only 42';
const CSRF = { 'X-Requested-With': 'guest-gateway' };

let adminHash;

function deviceOf(cookie) {
  return JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url')).deviceId;
}

function fakeImmich() {
  return {
    deleted: [],
    deleteError: null,
    async getAlbum() {
      return { assetCount: 2 };
    },
    async listAlbumAssets() {
      return {
        items: [
          { id: MINE, type: 'IMAGE', fileCreatedAt: '2026-10-10T03:00:00.000Z' },
          { id: THEIRS, type: 'IMAGE', fileCreatedAt: '2026-10-10T02:00:00.000Z' },
        ].filter((a) => !this.deleted.flat().includes(a.id)),
        nextCursor: null,
      };
    },
    async deleteAssets(ids) {
      if (this.deleteError) throw this.deleteError;
      this.deleted.push(ids);
    },
  };
}

async function setup({ deleteApiKey = 'delete-key', withAdmin = true } = {}) {
  adminHash ??= await hashPassword(ADMIN_PASSWORD);
  const store = openStore(':memory:');
  const immich = fakeImmich();
  const srv = await startServer(
    {
      immich: { albumId: ALBUM, deleteApiKey },
      adminPasswordHash: withAdmin ? adminHash : '',
    },
    { store, importer: { enqueue() {} }, immich },
  );
  const guest = (await login(srv.baseUrl, PASSWORD, 'たろう')).cookie;
  const row = { filename: 'x.jpg', mime: 'image/jpeg', size: 1, lastModified: null };
  store.add({ ...row, uploadId: 'u-mine', deviceId: deviceOf(guest), nickname: 'たろう' });
  store.markImported('u-mine', 'created', MINE);
  store.add({ ...row, uploadId: 'u-theirs', deviceId: 'other-device', nickname: 'はなこ' });
  store.markImported('u-theirs', 'created', THEIRS);
  // The guest also uploaded a copy of THEIRS: a duplicate is not theirs to delete.
  store.add({ ...row, uploadId: 'u-dup', deviceId: deviceOf(guest), nickname: 'たろう' });
  store.markImported('u-dup', 'duplicate', THEIRS);
  return { srv, store, immich, guest };
}

function del(srv, cookie, id, headers = CSRF) {
  return fetch(`${srv.baseUrl}/api/assets/${id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, ...headers },
  });
}

describe('deleting assets', () => {
  let ctx;
  afterEach(async () => {
    await ctx.srv.close();
    ctx.store.close();
  });

  it('lets a guest delete only what their device uploaded, then hides it', async () => {
    ctx = await setup();
    const { srv, immich, guest } = ctx;

    expect((await del(srv, guest, THEIRS)).status).toBe(403);
    expect(immich.deleted).toEqual([]);

    const res = await del(srv, guest, MINE);
    expect(res.status).toBe(200);
    expect(immich.deleted).toEqual([[MINE]]);

    const list = await (
      await fetch(`${srv.baseUrl}/api/assets`, { headers: { Cookie: guest } })
    ).json();
    expect(list.assets.map((a) => a.id)).toEqual([THEIRS]);
    // Deleting again is no longer allowed (the record is marked deleted).
    expect((await del(srv, guest, MINE)).status).toBe(403);
  });

  it('lets the organiser delete anything with the admin password', async () => {
    ctx = await setup();
    const { srv, immich } = ctx;
    const admin = await login(srv.baseUrl, ADMIN_PASSWORD, '幹事');
    expect(await admin.res.json()).toEqual({ ok: true, role: 'admin' });
    const session = await (
      await fetch(`${srv.baseUrl}/api/session`, { headers: { Cookie: admin.cookie } })
    ).json();
    expect(session).toMatchObject({ role: 'admin', canDelete: true });

    expect((await del(srv, admin.cookie, THEIRS)).status).toBe(200);
    expect(immich.deleted).toEqual([[THEIRS]]);
  });

  it('never grants admin when the admin password is not configured', async () => {
    ctx = await setup({ withAdmin: false });
    expect((await login(ctx.srv.baseUrl, ADMIN_PASSWORD, '幹事')).res.status).toBe(401);
  });

  it('requires the CSRF header and a session', async () => {
    ctx = await setup();
    const { srv, immich, guest } = ctx;
    expect((await del(srv, guest, MINE, {})).status).toBe(403);
    expect((await del(srv, '', MINE)).status).toBe(401);
    expect(immich.deleted).toEqual([]);
  });

  it('is unavailable without a delete key, and maps Immich errors', async () => {
    ctx = await setup({ deleteApiKey: '' });
    const { srv, guest } = ctx;
    const session = await (
      await fetch(`${srv.baseUrl}/api/session`, { headers: { Cookie: guest } })
    ).json();
    expect(session.canDelete).toBe(false);
    expect((await del(srv, guest, MINE)).status).toBe(404);
    await srv.close();
    ctx.store.close();

    ctx = await setup();
    ctx.immich.deleteError = new ImmichError('delete', 400);
    expect((await del(ctx.srv, ctx.guest, MINE)).status).toBe(404);
    ctx.immich.deleteError = new ImmichError('delete', 503);
    expect((await del(ctx.srv, ctx.guest, MINE)).status).toBe(502);
    expect((await del(ctx.srv, ctx.guest, 'not-a-uuid')).status).toBe(404);
  });
});
