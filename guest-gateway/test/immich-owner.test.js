// guest-gateway/test/immich-owner.test.js
// アルバム所有者(イベント用ユーザー)の取得: v3 の albumUsers から role=owner の id だけを読み、
// 分からなければ null。共有リンクキーをヘッダーで送り、Immich のエラーは ImmichError にする。

import http from 'node:http';
import { createImmichClient, ImmichError } from '../src/immich.js';

const ALBUM = '11111111-2222-4333-8444-555555555555';
const OWNER = 'eeeeeeee-0000-4000-8000-000000000001';
const EDITOR = 'eeeeeeee-0000-4000-8000-000000000002';

let server;
let baseUrl;
let reply;
const requests = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const [status, body] = reply();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const user = (id) => ({ id, email: `${id}@example.invalid`, name: 'x' });

describe('albumOwnerId', () => {
  it('reads the owner entry of albumUsers through the share key', async () => {
    reply = () => [
      200,
      {
        id: ALBUM,
        albumUsers: [
          { role: 'editor', user: user(EDITOR) },
          { role: 'owner', user: user(OWNER) },
        ],
      },
    ];
    const client = createImmichClient({ baseUrl, shareKey: 'share-key' });
    expect(await client.albumOwnerId(ALBUM)).toBe(OWNER);
    const last = requests.at(-1);
    expect(last.url).toBe(`/api/albums/${ALBUM}`);
    expect(last.headers['x-immich-share-key']).toBe('share-key');
  });

  it('returns null when the response does not name an owner', async () => {
    const client = createImmichClient({ baseUrl, shareKey: 'k' });
    for (const body of [
      { id: ALBUM },
      { albumUsers: [{ role: 'editor', user: user(EDITOR) }] },
      { albumUsers: [{ role: 'owner', user: { id: 'not-a-uuid' } }] },
    ]) {
      reply = () => [200, body];
      expect(await client.albumOwnerId(ALBUM)).toBeNull();
    }
  });

  it('maps errors and rejects bad album ids without a request', async () => {
    const client = createImmichClient({ baseUrl, shareKey: 'k' });
    reply = () => [403, { message: 'internal detail' }];
    const err = await client.albumOwnerId(ALBUM).catch((e) => e);
    expect(err).toBeInstanceOf(ImmichError);
    expect(err.status).toBe(403);
    expect(err.message).not.toMatch(/internal detail/);
    const before = requests.length;
    await expect(client.albumOwnerId('../users')).rejects.toBeInstanceOf(ImmichError);
    expect(requests).toHaveLength(before);
  });
});
