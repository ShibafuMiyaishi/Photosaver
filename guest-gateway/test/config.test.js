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
    expect(config.keepUploads).toBe(false);
    expect(config.cookieSecure).toBe(true);
    expect(config.closesAt).toBe(Date.parse(VALID.CLOSES_AT));
    expect(config.immich).toBeNull();
    expect(config.adminPasswordHash).toBe('');
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
  ])('rejects %s', (_label, override) => {
    expect(() => loadConfig({ ...VALID, ...override })).toThrow();
  });
});
