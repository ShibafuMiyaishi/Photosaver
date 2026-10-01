// guest-gateway/test/auth.test.js

import crypto from 'node:crypto';
import {
  hashPassword,
  normalizeNickname,
  parseScryptHash,
  SCRYPT_PARAMS,
  signSession,
  verifyPassword,
  verifySession,
} from '../src/auth.js';

const SECRET = 's'.repeat(64);

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('hunter2-hunter2');
    expect(stored.startsWith('scrypt:')).toBe(true);
    expect(stored).not.toContain('$');
    expect(await verifyPassword('hunter2-hunter2', stored)).toBe(true);
    expect(await verifyPassword('hunter2-hunter3', stored)).toBe(false);
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:a:b:c:d:e')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:16384:8:1::')).toBe(false);
    expect(await verifyPassword(undefined, 'scrypt:16384:8:1:a:b')).toBe(false);
  });

  it('hashes new passwords with N=2^17, r=8, p=1 (needs more than the default maxmem)', async () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 });
    const stored = await hashPassword('hunter2-hunter2');
    expect(stored.split(':').slice(1, 4)).toEqual(['131072', '8', '1']);
    expect(await verifyPassword('hunter2-hunter2', stored)).toBe(true);
  });

  it('still verifies hashes made with the old N=2^14 using the stored parameters', async () => {
    const salt = Buffer.from('old-salt-16bytes');
    const key = crypto.scryptSync('old password!', salt, 32, { N: 16384, r: 8, p: 1 });
    const stored = ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')];
    expect(await verifyPassword('old password!', stored.join(':'))).toBe(true);
    expect(await verifyPassword('old password?', stored.join(':'))).toBe(false);
  });

  it.each([
    ['N not a power of 2', 'scrypt:100000:8:1:c2FsdA:aGFzaA', /power of 2/],
    ['N above 2^20', 'scrypt:2097152:8:1:c2FsdA:aGFzaA', /power of 2/],
    ['N below 2^14', 'scrypt:1024:8:1:c2FsdA:aGFzaA', /power of 2/],
    ['r above 32', 'scrypt:16384:64:1:c2FsdA:aGFzaA', /r must/],
    ['r zero', 'scrypt:16384:0:1:c2FsdA:aGFzaA', /r must/],
    ['p above 16', 'scrypt:16384:8:17:c2FsdA:aGFzaA', /p must/],
    ['more than 1 GiB', 'scrypt:1048576:16:1:c2FsdA:aGFzaA', /1 GiB/],
    ['non-decimal N', 'scrypt:0x4000:8:1:c2FsdA:aGFzaA', /integers/],
    ['empty hash', 'scrypt:16384:8:1:c2FsdA:', /empty/],
    ['wrong format', 'scrypt$16384$8$1', /format/],
  ])('rejects absurd or malformed parameters: %s', async (_label, stored, message) => {
    expect(parseScryptHash(stored).error).toMatch(message);
    expect(await verifyPassword('x', stored)).toBe(false);
  });

  it('accepts a sane stored hash and refuses to hash with absurd parameters', async () => {
    expect(parseScryptHash('scrypt:131072:8:1:c2FsdA:aGFzaA')).toMatchObject({
      params: { N: 131072, r: 8, p: 1 },
    });
    await expect(hashPassword('x', { N: 3, r: 8, p: 1 })).rejects.toThrow(/power of 2/);
  });
});

describe('session tokens', () => {
  const session = {
    deviceId: 'dev-1',
    nickname: 'たろう',
    role: 'guest',
    exp: Date.now() + 60_000,
  };

  it('round-trips a signed session', () => {
    const token = signSession(session, SECRET);
    expect(verifySession(token, SECRET)).toEqual(session);
  });

  it('rejects tampered payloads, wrong secrets and garbage', () => {
    const token = signSession(session, SECRET);
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...session, role: 'admin' })).toString('base64url');
    expect(verifySession(`${forged}.${mac}`, SECRET)).toBeNull();
    expect(verifySession(token, 't'.repeat(64))).toBeNull();
    expect(verifySession(`${payload}.${mac}.extra`, SECRET)).toBeNull();
    expect(verifySession('', SECRET)).toBeNull();
    expect(verifySession(undefined, SECRET)).toBeNull();
  });

  it('rejects sessions without a nickname (issued before nicknames existed)', () => {
    const legacy = { ...session };
    delete legacy.nickname;
    expect(verifySession(signSession(legacy, SECRET), SECRET)).toBeNull();
  });

  it('accepts guest and admin roles only', () => {
    expect(verifySession(signSession({ ...session, role: 'admin' }, SECRET), SECRET)).toMatchObject(
      {
        role: 'admin',
      },
    );
    expect(verifySession(signSession({ ...session, role: 'root' }, SECRET), SECRET)).toBeNull();
  });

  it('rejects expired sessions', () => {
    const token = signSession({ ...session, exp: Date.now() - 1 }, SECRET);
    expect(verifySession(token, SECRET)).toBeNull();
  });
});

describe('normalizeNickname', () => {
  it.each([
    ['  たろう  ', 'たろう'],
    ['山田\n花子', '山田 花子'],
    ['a\u202Eb', 'ab'],
    ['\uFEFFけん', 'けん'],
    ['👨\u200D👩\u200D👧', '👨\u200D👩\u200D👧'],
    ['x'.repeat(20), 'x'.repeat(20)],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeNickname(input)).toBe(expected);
  });

  it.each([['x'.repeat(21)], [''], ['   '], ['\u200B'], [undefined], [42], ['a'.repeat(201)]])(
    'rejects %j',
    (input) => {
      expect(normalizeNickname(input)).toBeNull();
    },
  );
});
