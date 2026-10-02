// guest-gateway/test/config.test.js

import { loadConfig } from '../src/config.js';

const VALID = {
  SESSION_SECRET: 'a'.repeat(64),
  GUEST_PASSWORD_HASH: 'scrypt:16384:8:1:c2FsdA:aGFzaA',
  CLOSES_AT: '2026-10-31T23:59:00+09:00',
  STAGING_DIR: '/data/staging',
};

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig(VALID);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8080);
    expect(config.maxFileBytes).toBe(4 * 1024 ** 3);
    expect(config.minFreeBytes).toBe(50 * 1024 ** 3);
    expect(config.keepUploads).toBe(false);
    expect(config.cookieSecure).toBe(true);
    expect(config.closesAt).toBe(Date.parse(VALID.CLOSES_AT));
    expect(config.immich).toBeNull();
    expect(config.adminPasswordHash).toBe('');
    expect(config.loginMaxFailures).toBe(20);
    expect(config.loginLockMs).toBe(2 * 60 * 1000);
  });

  it('reads the login lockout tuning', () => {
    const config = loadConfig({ ...VALID, LOGIN_MAX_FAILURES: '30', LOGIN_LOCK_MINUTES: '0.5' });
    expect(config.loginMaxFailures).toBe(30);
    expect(config.loginLockMs).toBe(30 * 1000);
    expect(loadConfig({ ...VALID, LOGIN_LOCK_MINUTES: '60' }).loginLockMs).toBe(60 * 60 * 1000);
  });

  const IMPORT = {
    IMMICH_SHARE_KEY: 'share-key-from-setup-event',
    IMMICH_ALBUM_ID: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    DB_PATH: '/data/db/gateway.db',
  };

  it('enables import mode when the share key is set', () => {
    const config = loadConfig({ ...VALID, ...IMPORT });
    expect(config.immich).toEqual({
      baseUrl: 'http://immich-server:2283/',
      shareKey: IMPORT.IMMICH_SHARE_KEY,
      albumId: IMPORT.IMMICH_ALBUM_ID,
      deleteApiKey: '',
      dbPath: IMPORT.DB_PATH,
    });
  });

  it.each([
    ['placeholder share key', { IMMICH_SHARE_KEY: 'CHANGE_ME' }],
    ['missing album id', { IMMICH_ALBUM_ID: '' }],
    ['non-UUID album id', { IMMICH_ALBUM_ID: '../albums' }],
    ['missing DB path', { DB_PATH: '' }],
    ['relative Immich URL', { IMMICH_URL: 'immich-server:2283' }],
    ['non-http Immich URL', { IMMICH_URL: 'file:///etc/passwd' }],
  ])('rejects import mode with %s', (_label, override) => {
    expect(() => loadConfig({ ...VALID, ...IMPORT, ...override })).toThrow();
  });

  it.each([
    ['short secret', { SESSION_SECRET: 'short' }],
    ['placeholder secret', { SESSION_SECRET: 'CHANGE_ME' }],
    ['missing hash', { GUEST_PASSWORD_HASH: '' }],
    ['bcrypt-style hash', { GUEST_PASSWORD_HASH: '$2b$10$abc' }],
    ['bad deadline', { CLOSES_AT: 'next friday' }],
    ['missing staging dir', { STAGING_DIR: '' }],
    ['negative size', { MAX_FILE_GB: '-1' }],
    ['non-scrypt admin hash', { ADMIN_PASSWORD_HASH: 'plaintext-password' }],
    ['zero login failures', { LOGIN_MAX_FAILURES: '0' }],
    ['fractional login failures', { LOGIN_MAX_FAILURES: '2.5' }],
    ['non-numeric login failures', { LOGIN_MAX_FAILURES: 'many' }],
    ['negative lock minutes', { LOGIN_LOCK_MINUTES: '-1' }],
    ['lock longer than the cap', { LOGIN_LOCK_MINUTES: '61' }],
    ['fractional proxy hops', { TRUST_PROXY_HOPS: '1.5' }],
    ['zero proxy hops', { TRUST_PROXY_HOPS: '0' }],
    ['non-numeric proxy hops', { TRUST_PROXY_HOPS: 'x' }],
  ])('rejects %s', (_label, override) => {
    expect(() => loadConfig({ ...VALID, ...override })).toThrow();
  });

  it('reads TRUST_PROXY_HOPS as a positive integer (default 1)', () => {
    expect(loadConfig(VALID).trustProxyHops).toBe(1);
    expect(loadConfig({ ...VALID, TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
  });

  it.each([
    ['GUEST_PASSWORD_HASH', 'N above 2^20', 'scrypt:2097152:8:1:c2FsdA:aGFzaA'],
    ['GUEST_PASSWORD_HASH', 'N not a power of 2', 'scrypt:100000:8:1:c2FsdA:aGFzaA'],
    ['GUEST_PASSWORD_HASH', 'r above 32', 'scrypt:16384:33:1:c2FsdA:aGFzaA'],
    ['GUEST_PASSWORD_HASH', 'p above 16', 'scrypt:16384:8:17:c2FsdA:aGFzaA'],
    ['GUEST_PASSWORD_HASH', 'missing parts', 'scrypt:16384:8:1'],
    ['ADMIN_PASSWORD_HASH', 'N above 2^20', 'scrypt:2097152:8:1:c2FsdA:aGFzaA'],
  ])('rejects %s with %s', (name, _label, value) => {
    expect(() => loadConfig({ ...VALID, [name]: value })).toThrow(
      new RegExp(`^${name} is not a usable scrypt hash`),
    );
  });

  it('accepts hashes with the old N=2^14 and the current N=2^17', () => {
    const current = 'scrypt:131072:8:1:c2FsdA:aGFzaA';
    const config = loadConfig({ ...VALID, ADMIN_PASSWORD_HASH: current });
    expect(config.guestPasswordHash).toBe(VALID.GUEST_PASSWORD_HASH);
    expect(config.adminPasswordHash).toBe(current);
  });
});
