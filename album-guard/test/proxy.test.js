// album-guard/test/proxy.test.js
// proxy.js の単体テスト(17 ケース)。
// extractAlbumId の regex、extractToken の header 優先順位、albumAuthMiddleware の gate 動作。

const fs = require('node:fs');
const path = require('node:path');
// Vitest globals (describe/it/expect/vi/...) は vitest.config.js の `globals: true` で注入。
const { mktmp, bustSrcCache } = require('./helpers/tmp');
const { buildFixture, ENTRIES } = require('./fixtures/passwords');

const UUID_A = Object.keys(ENTRIES)[0];

describe('proxy', () => {
  let proxy;
  let auth;

  beforeEach(async () => {
    bustSrcCache();
    process.env.GUARD_JWT_SECRET = 'a'.repeat(64);
    const dir = mktmp('proxy');
    const fixturePath = path.join(dir, 'album-passwords.json');
    fs.writeFileSync(fixturePath, JSON.stringify(await buildFixture(), null, 2));
    process.env.GUARD_PASSWORDS_FILE = fixturePath;
    proxy = require('../src/proxy');
    auth = require('../src/auth');
  });

  afterEach(() => {
    if (auth && auth._testHooks) auth._testHooks.stop();
  });

  // ================= extractAlbumId =================

  describe('extractAlbumId', () => {
    const BARE = '/api/albums/550e8400-e29b-41d4-a716-446655440000';

    it('matches bare album path', () => {
      expect(proxy.extractAlbumId(BARE)).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('matches album/assets suffix', () => {
      expect(proxy.extractAlbumId(BARE + '/assets')).toBe(
        '550e8400-e29b-41d4-a716-446655440000',
      );
    });

    it('matches uppercase hex', () => {
      expect(
        proxy.extractAlbumId('/api/albums/550E8400-E29B-41D4-A716-446655440000'),
      ).toBe('550E8400-E29B-41D4-A716-446655440000');
    });

    it('returns null for non-UUID slug', () => {
      expect(proxy.extractAlbumId('/api/albums/notauuid')).toBeNull();
    });

    it('returns null for /api/albums without id', () => {
      expect(proxy.extractAlbumId('/api/albums')).toBeNull();
    });

    it('returns null for /api/users/<uuid> (prefix must be /api/albums)', () => {
      expect(
        proxy.extractAlbumId('/api/users/550e8400-e29b-41d4-a716-446655440000'),
      ).toBeNull();
    });

    it('returns null when UUID appears later in path (regex drift guard)', () => {
      expect(
        proxy.extractAlbumId(
          '/api/foo/bar/550e8400-e29b-41d4-a716-446655440000/albums',
        ),
      ).toBeNull();
    });
  });

  // ================= extractToken =================

  describe('extractToken', () => {
    it('returns X-Album-Token value', () => {
      expect(proxy.extractToken({ headers: { 'x-album-token': 'abc' } })).toBe('abc');
    });

    it('falls back to Bearer when X-Album-Token absent', () => {
      expect(proxy.extractToken({ headers: { authorization: 'Bearer xyz' } })).toBe(
        'xyz',
      );
    });

    it('prefers X-Album-Token over Bearer when both present', () => {
      expect(
        proxy.extractToken({
          headers: { 'x-album-token': 'primary', authorization: 'Bearer secondary' },
        }),
      ).toBe('primary');
    });

    it('returns null when neither header present', () => {
      expect(proxy.extractToken({ headers: {} })).toBeNull();
    });

    it('returns null for query-string token (headers-only policy)', () => {
      expect(
        proxy.extractToken({ headers: {}, query: { token: 'should-be-ignored' } }),
      ).toBeNull();
    });

    it('returns null for unknown auth scheme (Basic)', () => {
      expect(
        proxy.extractToken({ headers: { authorization: 'Basic bW86YQ==' } }),
      ).toBeNull();
    });
  });

  // ================= albumAuthMiddleware =================

  describe('albumAuthMiddleware', () => {
    function fakeRes() {
      return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };
    }

    it('next() for non-album path', () => {
      const req = { path: '/api/server/ping', headers: {} };
      const res = fakeRes();
      const next = vi.fn();
      proxy.albumAuthMiddleware(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('next() for album path that is not protected', () => {
      const req = {
        path: '/api/albums/99999999-9999-4999-8999-999999999999',
        headers: {},
      };
      const res = fakeRes();
      const next = vi.fn();
      proxy.albumAuthMiddleware(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it('401 + Cache-Control:no-store for protected + no token', () => {
      const req = { path: '/api/albums/' + UUID_A, headers: {} };
      const res = fakeRes();
      const next = vi.fn();
      proxy.albumAuthMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(res.status).toHaveBeenCalledWith(401);
      const body = res.json.mock.calls[0][0];
      expect(body.error).toMatch(/password protected/i);
      expect(body.albumId).toBe(UUID_A);
    });

    it('next() when protected + valid token', async () => {
      const token = await auth.verifyPasswordAndSign(
        UUID_A,
        ENTRIES[UUID_A].plaintext,
      );
      const req = {
        path: '/api/albums/' + UUID_A,
        headers: { 'x-album-token': token },
      };
      const res = fakeRes();
      const next = vi.fn();
      proxy.albumAuthMiddleware(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    });
  });
});
