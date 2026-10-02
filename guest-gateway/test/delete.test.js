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
// Added by the organiser's own Immich account: in the album, but not the event user's.
const FOREIGN = '88888888-9999-4aaa-bbbb-cccccccccccc';
const EVENT_USER = 'eeeeeeee-0000-4000-8000-000000000001';
const ORGANISER_USER = 'eeeeeeee-0000-4000-8000-000000000002';
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
    // null = Immich did not say who owns the album.
    owner: EVENT_USER,
    ownerCalls: 0,
    async getAlbum() {
      return { assetCount: 3 };
    },
    async albumOwnerId() {
      this.ownerCalls += 1;
      return this.owner;
    },
    async listAlbumAssets() {
      return {
        items: [
          {
            id: MINE,
            ownerId: EVENT_USER,
            type: 'IMAGE',
            fileCreatedAt: '2026-10-10T03:00:00.000Z',
          },
          {
            id: THEIRS,
            ownerId: EVENT_USER,
            type: 'IMAGE',
            fileCreatedAt: '2026-10-10T02:00:00.000Z',
          },
          {
            id: FOREIGN,
            ownerId: ORGANISER_USER,
            type: 'IMAGE',
            fileCreatedAt: '2026-10-10T01:00:00.000Z',
          },
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

async function setup({ deleteApiKey = 'delete-key', withAdmin = true, adminPasswordHash } = {}) {
  adminHash ??= await hashPassword(ADMIN_PASSWORD);
  const store = openStore(':memory:');
  const immich = fakeImmich();
  const srv = await startServer(
    {
      immich: { albumId: ALBUM, deleteApiKey },
      adminPasswordHash: adminPasswordHash ?? (withAdmin ? adminHash : ''),
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

async function listing(srv, cookie) {
  const res = await fetch(`${srv.baseUrl}/api/assets`, { headers: { Cookie: cookie } });
  return Object.fromEntries((await res.json()).assets.map((a) => [a.id, a.deletable]));
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
    expect(list.assets.map((a) => a.id)).toEqual([THEIRS, FOREIGN]);
    // Ownership survives the delete (only marked), so a restored photo stays deletable.
    expect(ctx.store.isOwnAsset(MINE, deviceOf(guest))).toBe(true);
    expect(ctx.store.wasDeleted(MINE)).toBe(true);
  });

  it('lets the organiser delete anything with the admin password', async () => {
    ctx = await setup();
    const { srv, immich } = ctx;
    const admin = await login(srv.baseUrl, ADMIN_PASSWORD, '幹事');
    expect(await admin.res.json()).toEqual({ ok: true, role: 'admin', nickname: '幹事' });
    const session = await (
      await fetch(`${srv.baseUrl}/api/session`, { headers: { Cookie: admin.cookie } })
    ).json();
    expect(session).toMatchObject({ role: 'admin', canDelete: true });

    expect((await del(srv, admin.cookie, THEIRS)).status).toBe(200);
    expect(immich.deleted).toEqual([[THEIRS]]);
  });

  it('marks what each role may delete in the listing', async () => {
    ctx = await setup();
    const { srv, immich, guest } = ctx;
    // Guest: exactly their own uploads (a duplicate of someone else's photo does not count).
    expect(await listing(srv, guest)).toEqual({ [MINE]: true, [THEIRS]: false, [FOREIGN]: false });
    // Guests never cause the owner lookup.
    expect(immich.ownerCalls).toBe(0);
    const admin = (await login(srv.baseUrl, ADMIN_PASSWORD, '幹事')).cookie;
    expect(await listing(srv, admin)).toEqual({ [MINE]: true, [THEIRS]: true, [FOREIGN]: false });
    // The owner never changes: looked up once.
    await listing(srv, admin);
    expect(immich.ownerCalls).toBe(1);
  });

  it('answers not_deletable when the organiser deletes an asset the event user does not own', async () => {
    ctx = await setup();
    const { srv, immich } = ctx;
    const admin = (await login(srv.baseUrl, ADMIN_PASSWORD, '幹事')).cookie;
    const res = await del(srv, admin, FOREIGN);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_deletable' });
    expect(immich.deleted).toEqual([]);
    // Guests keep their plain forbidden.
    const guestRes = await del(srv, ctx.guest, FOREIGN);
    expect(guestRes.status).toBe(403);
    expect(await guestRes.json()).toEqual({ error: 'forbidden' });
  });

  it('falls back to Immich when the owner is unknown, mapping its refusal to not_deletable', async () => {
    ctx = await setup();
    const { srv, immich } = ctx;
    immich.owner = null;
    const admin = (await login(srv.baseUrl, ADMIN_PASSWORD, '幹事')).cookie;
    expect(await listing(srv, admin)).toEqual({ [MINE]: true, [THEIRS]: true, [FOREIGN]: true });
    // Immich answers 400 for an asset the delete key's user does not own.
    immich.deleteError = new ImmichError('delete', 400);
    const res = await del(srv, admin, FOREIGN);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_deletable' });
    expect(ctx.store.wasDeleted(FOREIGN)).toBe(false);
    // 404 from Immich stays not_found; a lookup failure is retried later.
    immich.deleteError = new ImmichError('delete', 404);
    expect(await (await del(srv, admin, THEIRS)).json()).toEqual({ error: 'not_found' });
    immich.owner = EVENT_USER;
    immich.deleteError = null;
    expect((await del(srv, admin, FOREIGN)).status).toBe(403);
    expect(immich.deleted).toEqual([]);
    expect((await del(srv, admin, THEIRS)).status).toBe(200);
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
    // A wrong or under-permissioned delete key must never look like a successful delete.
    for (const status of [401, 403]) {
      ctx.immich.deleteError = new ImmichError('delete', status);
      expect((await del(ctx.srv, ctx.guest, MINE)).status).toBe(502);
    }
    expect((await del(ctx.srv, ctx.guest, 'not-a-uuid')).status).toBe(404);
  });

  it('limits even the organiser to assets in the event album', async () => {
    ctx = await setup();
    const admin = (await login(ctx.srv.baseUrl, ADMIN_PASSWORD, '幹事')).cookie;
    const outside = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    expect((await del(ctx.srv, admin, outside)).status).toBe(404);
    expect(ctx.immich.deleted).toEqual([]);
  });

  it('demotes admin sessions when the organiser password changes', async () => {
    ctx = await setup();
    const admin = (await login(ctx.srv.baseUrl, ADMIN_PASSWORD, '幹事')).cookie;
    await ctx.srv.close();
    ctx.store.close();
    // Same session secret, new organiser password: the old admin cookie is only a guest now.
    ctx = await setup({ adminPasswordHash: await hashPassword('a brand new organiser pw') });
    const session = await (
      await fetch(`${ctx.srv.baseUrl}/api/session`, { headers: { Cookie: admin } })
    ).json();
    expect(session.role).toBe('guest');
    expect((await del(ctx.srv, admin, THEIRS)).status).toBe(403);
  });
});
