// album-guard/test/auth.test.js
// auth.js の単体テスト(12 ケース)。
// 各テストで tmp/ に独立した fixture を作り、vi.resetModules() で auth.js をフレッシュに require する。

const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
// Vitest globals (describe/it/expect/vi/...) は vitest.config.js の `globals: true` で注入。
const { mktmp, bustSrcCache } = require('./helpers/tmp');
const { buildFixture, ENTRIES } = require('./fixtures/passwords');

const UUID_A = Object.keys(ENTRIES)[0];
const UUID_B = Object.keys(ENTRIES)[1];
const SECRET = 'a'.repeat(64);

describe('auth', () => {
  let auth;
  let fixturePath;

  beforeEach(async () => {
    bustSrcCache();
    process.env.GUARD_JWT_SECRET = SECRET;
    const dir = mktmp('auth');
    fixturePath = path.join(dir, 'album-passwords.json');
    fs.writeFileSync(fixturePath, JSON.stringify(await buildFixture(), null, 2));
    process.env.GUARD_PASSWORDS_FILE = fixturePath;
    auth = require('../src/auth');
  });

  afterEach(() => {
    if (auth && auth._testHooks) auth._testHooks.stop();
  });

  // ----- isProtected -----

  it('isProtected: true for a registered UUID', () => {
    expect(auth.isProtected(UUID_A)).toBe(true);
  });

  it('isProtected: false for an unregistered UUID', () => {
    expect(auth.isProtected('99999999-9999-4999-8999-999999999999')).toBe(false);
  });

  // ----- verifyPasswordAndSign -----

  it('verifyPasswordAndSign: returns a JWT on correct password', async () => {
    const token = await auth.verifyPasswordAndSign(UUID_A, ENTRIES[UUID_A].plaintext);
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    expect(payload.albumId).toBe(UUID_A);
    expect(payload.label).toBe(ENTRIES[UUID_A].label);
  });

  it('verifyPasswordAndSign: null on wrong password', async () => {
    const token = await auth.verifyPasswordAndSign(UUID_A, 'wrong');
    expect(token).toBeNull();
  });

  it('verifyPasswordAndSign: null on missing album', async () => {
    const token = await auth.verifyPasswordAndSign(
      '99999999-9999-4999-8999-999999999999',
      'whatever',
    );
    expect(token).toBeNull();
  });

  // ----- verifyToken -----

  it('verifyToken: true on valid same-album token', async () => {
    const token = await auth.verifyPasswordAndSign(UUID_A, ENTRIES[UUID_A].plaintext);
    expect(auth.verifyToken(token, UUID_A)).toBe(true);
  });

  it('verifyToken: false when token for A is presented for B', async () => {
    const token = await auth.verifyPasswordAndSign(UUID_A, ENTRIES[UUID_A].plaintext);
    expect(auth.verifyToken(token, UUID_B)).toBe(false);
  });

  it('verifyToken: false on expired token', async () => {
    // 直接 jwt.sign で 1ms 期限のトークンを生成(auth モジュールでは expiresIn 制御できない)
    const token = jwt.sign({ albumId: UUID_A, label: '' }, SECRET, {
      expiresIn: '1ms',
      algorithm: 'HS256',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(auth.verifyToken(token, UUID_A)).toBe(false);
  });

  it('verifyToken: false on tampered signature', async () => {
    const token = await auth.verifyPasswordAndSign(UUID_A, ENTRIES[UUID_A].plaintext);
    const parts = token.split('.');
    const sig = parts[2];
    const flippedChar = sig[sig.length - 1] === 'A' ? 'B' : 'A';
    const tampered = parts.slice(0, 2).join('.') + '.' + sig.slice(0, -1) + flippedChar;
    expect(auth.verifyToken(tampered, UUID_A)).toBe(false);
  });

  // ----- hashPassword -----

  it('hashPassword: round-trip matches original', async () => {
    const hash = await auth.hashPassword('my-password');
    expect(await bcrypt.compare('my-password', hash)).toBe(true);
    expect(await bcrypt.compare('different', hash)).toBe(false);
    // bcrypt format: $2a$10$... or $2b$10$...
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
  });

  // ----- Hot reload -----
  // 注意: Windows NTFS の mtime 解像度が 2 秒ある + fs.watch(file) が同一プロセス書き込みで
  // 発火しないケースがあるため、デテミナスティックに `_testHooks.reload()` を使って
  // ロード経路を検証する。fs.watch 自体の統合テストは E2E(運用中)に委ねる。

  it('loadPasswords: picks up newly added UUID after file rewrite', async () => {
    const NEW_UUID = 'aabbccdd-aabb-4abb-8abb-aabbccddeeff';
    expect(auth.isProtected(NEW_UUID)).toBe(false);

    const hash = await bcrypt.hash('newpass', 10);
    const cur = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    cur[NEW_UUID] = { label: 'new', hash, expiresIn: '1h' };
    fs.writeFileSync(fixturePath, JSON.stringify(cur, null, 2));

    auth._testHooks.reload();
    expect(auth.isProtected(NEW_UUID)).toBe(true);
  });

  it('loadPasswords: malformed JSON → warn + empty map, not crash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(fixturePath, 'not valid json');

    auth._testHooks.reload();
    expect(warn).toHaveBeenCalled();
    expect(auth.isProtected(UUID_A)).toBe(false);
    warn.mockRestore();
  });
});
