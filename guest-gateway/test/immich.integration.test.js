// guest-gateway/test/immich.integration.test.js
// 開発用 Immich(guest-gateway/dev/compose.yml)に対する結合テスト。環境変数があるときだけ実行する:
//   IMMICH_IT_URL=http://127.0.0.1:2283 IMMICH_IT_ADMIN_EMAIL=... IMMICH_IT_ADMIN_PASSWORD=... npm test
// 毎回新しい専用ユーザー・アルバムを作るので、開発用 Immich 以外には向けないこと。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupEvent } from '../scripts/setup-event.js';
import { createImmichClient, ImmichError } from '../src/immich.js';
import { createImporter } from '../src/importer.js';
import { openStore } from '../src/store.js';
import { TMP_ROOT } from './helpers/server.js';

const RUN = Boolean(process.env.IMMICH_IT_URL);

// Two different 1x1 PNGs (different checksums).
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

async function waitFor(check, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!RUN)('Immich v3 integration (dev Immich)', () => {
  let event;
  let client;
  const files = {};

  beforeAll(async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    event = await setupEvent({
      baseUrl: process.env.IMMICH_IT_URL,
      adminEmail: process.env.IMMICH_IT_ADMIN_EMAIL,
      adminPassword: process.env.IMMICH_IT_ADMIN_PASSWORD,
      albumName: `it-${suffix}`,
      eventEmail: `it-${suffix}@example.com`,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      devInitAdmin: true,
    });
    client = createImmichClient({
      baseUrl: process.env.IMMICH_IT_URL,
      shareKey: event.shareKey,
      deleteApiKey: event.deleteApiKey,
    });
    await fs.mkdir(TMP_ROOT, { recursive: true });
    for (const [name, data] of [
      ['a', PNG_A],
      ['b', PNG_B],
    ]) {
      files[name] = path.join(TMP_ROOT, `it-${suffix}-${name}.png`);
      await fs.writeFile(files[name], data);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all(Object.values(files).map((f) => fs.rm(f, { force: true })));
  });

  it('runs a patched Immich (>= 3.2.4)', async () => {
    const v = await client.serverVersion();
    expect(v.major > 3 || (v.major === 3 && (v.minor > 2 || (v.minor === 2 && v.patch >= 4)))).toBe(
      true,
    );
  });

  it('adds share-link uploads to the album, also for duplicates', async () => {
    const first = await client.uploadAsset({
      filePath: files.a,
      filename: 'IMG_A.png',
      mime: 'image/png',
      lastModified: Date.now(),
    });
    expect(first.status).toBe('created');
    const again = await client.uploadAsset({
      filePath: files.a,
      filename: 'IMG_A.png',
      mime: 'image/png',
    });
    expect(again).toEqual({ status: 'duplicate', id: first.id });
    const album = await client.getAlbum(event.albumId);
    expect(album.assetCount).toBe(1);
  });

  it('lists the album with cursor paging', async () => {
    await client.uploadAsset({ filePath: files.b, filename: 'IMG_B.png', mime: 'image/png' });
    const firstPage = await waitFor(async () => {
      const page = await client.listAlbumAssets({ albumId: event.albumId, size: 1 });
      return page.items.length === 1 && page.nextCursor ? page : null;
    });
    expect(firstPage).toBeTruthy();
    const second = await client.listAlbumAssets({
      albumId: event.albumId,
      size: 1,
      cursor: firstPage.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(firstPage.items[0].id);
  });

  it('imports a staged file through the queue into the album', async () => {
    const dir = path.join(TMP_ROOT, `it-import-${crypto.randomUUID().slice(0, 8)}`);
    await fs.mkdir(dir, { recursive: true });
    const store = openStore(':memory:');
    try {
      // A third distinct PNG: 2x1 pixels, so its checksum differs from A and B.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DAwMDAwAAAD/4BAJiuVAoAAAAASUVORK5CYII=',
        'base64',
      );
      await fs.writeFile(path.join(dir, 'up1'), png);
      store.add({
        uploadId: 'up1',
        deviceId: 'dev-it',
        nickname: 'IT',
        filename: 'IMG_C.png',
        mime: 'image/png',
        size: png.length,
        lastModified: Date.now(),
      });
      const before = (await client.getAlbum(event.albumId)).assetCount;
      const importer = createImporter({ store, immich: client, dir });
      importer.enqueue('up1');
      await importer.idle();
      expect(store.get('up1')).toMatchObject({ status: 'created' });
      expect((await client.getAlbum(event.albumId)).assetCount).toBe(before + 1);
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('deletes with the delete-only API key', async () => {
    const page = await client.listAlbumAssets({ albumId: event.albumId });
    const [victim] = page.items;
    await client.deleteAssets([victim.id]);
    const gone = await waitFor(async () => {
      const after = await client.listAlbumAssets({ albumId: event.albumId });
      return after.items.every((a) => a.id !== victim.id);
    });
    expect(gone).toBe(true);
  });

  it('rejects a wrong share key', async () => {
    const bad = createImmichClient({ baseUrl: process.env.IMMICH_IT_URL, shareKey: 'wrong-key' });
    const err = await bad.getAlbum(event.albumId).catch((e) => e);
    expect(err).toBeInstanceOf(ImmichError);
    expect([401, 403]).toContain(err.status);
  });
});
