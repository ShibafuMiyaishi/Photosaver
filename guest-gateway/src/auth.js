// guest-gateway/src/auth.js
// 合言葉のハッシュ照合(scrypt)と、HMAC 署名付きセッション Cookie の発行・検証。

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// Hash format: scrypt:N:r:p:saltB64url:hashB64url
// ':' is used instead of '$' so docker compose env files do not try to interpolate it.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const key = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: MAXMEM });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger)) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * @param {{ deviceId: string, role: 'guest', exp: number }} session
 */
export function signSession(session, secret) {
  const payloadB64 = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [payloadB64, mac, extra] = token.split('.');
  if (!payloadB64 || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(payloadB64, secret));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  let session;
  try {
    session = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!session || typeof session.deviceId !== 'string' || typeof session.exp !== 'number') {
    return null;
  }
  if (session.exp <= now) return null;
  return session;
}

export function newDeviceId() {
  return crypto.randomUUID();
}
