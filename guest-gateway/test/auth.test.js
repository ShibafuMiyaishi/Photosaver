// guest-gateway/test/auth.test.js

import {
  hashPassword,
  normalizeNickname,
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
