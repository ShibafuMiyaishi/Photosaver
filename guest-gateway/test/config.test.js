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
  });

  it.each([
    ['short secret', { SESSION_SECRET: 'short' }],
    ['placeholder secret', { SESSION_SECRET: 'CHANGE_ME' }],
    ['missing hash', { GUEST_PASSWORD_HASH: '' }],
    ['bcrypt-style hash', { GUEST_PASSWORD_HASH: '$2b$10$abc' }],
    ['bad deadline', { CLOSES_AT: 'next friday' }],
    ['missing staging dir', { STAGING_DIR: '' }],
    ['negative size', { MAX_FILE_GB: '-1' }],
  ])('rejects %s', (_label, override) => {
    expect(() => loadConfig({ ...VALID, ...override })).toThrow();
  });
});
