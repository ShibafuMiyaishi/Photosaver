// guest-gateway/src/auth.js
// 合言葉のハッシュ生成・照合(scrypt)と、HMAC 署名付きセッション Cookie の発行・検証、ニックネームの正規化。

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// Hash format: scrypt:N:r:p:saltB64url:hashB64url
// ':' is used instead of '$' so docker compose env files do not try to interpolate it.
// New hashes use OWASP's scrypt parameters (N=2^17, r=8, p=1): ~128 MiB and ~0.2 s per check
// on an Apple M3 (measured 2026-10-01; expect more on the mini PC's i5-9500T). Verification always uses the parameters stored in
// the hash, so hashes made with the old N=2^14 keep working until they are regenerated.
export const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
// Accepted range for stored hashes (checked at config load and before every check): anything
// outside it is a typo or a value that could exhaust memory or CPU.
const SCRYPT_LIMITS = Object.freeze({
  minN: 2 ** 14,
  maxN: 2 ** 20,
  maxR: 32,
  maxP: 16,
  maxMemBytes: 1024 ** 3,
});
const KEY_LEN = 32;

/**
 * maxmem for crypto.scrypt. Node's default (32 MiB) is below the ~128 MiB (128·N·r) that
 * N=2^17, r=8 needs; twice that term also covers the p·128·r block buffers for any accepted p.
 */
function maxmemFor({ N, r }) {
  return 2 * 128 * N * r;
}

/** @returns {string | null} why the parameters are unacceptable, or null if they are fine */
function scryptParamsProblem({ N, r, p }) {
  if (![N, r, p].every(Number.isSafeInteger)) return 'N, r and p must be integers';
  if (N < SCRYPT_LIMITS.minN || N > SCRYPT_LIMITS.maxN || (N & (N - 1)) !== 0) {
    return `N must be a power of 2 from ${SCRYPT_LIMITS.minN} to ${SCRYPT_LIMITS.maxN}`;
  }
  if (r < 1 || r > SCRYPT_LIMITS.maxR) return `r must be from 1 to ${SCRYPT_LIMITS.maxR}`;
  if (p < 1 || p > SCRYPT_LIMITS.maxP) return `p must be from 1 to ${SCRYPT_LIMITS.maxP}`;
  if (128 * N * r > SCRYPT_LIMITS.maxMemBytes) return 'N and r need more than 1 GiB of memory';
  return null;
}

/**
 * Parse a stored `scrypt:N:r:p:salt:hash` string.
 * @returns {{ params: { N: number, r: number, p: number }, salt: Buffer, expected: Buffer }
 *   | { error: string }}
 */
export function parseScryptHash(stored) {
  if (typeof stored !== 'string') return { error: 'not a string' };
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return { error: 'expected the format scrypt:N:r:p:salt:hash' };
  }
  const [N, r, p] = parts.slice(1, 4).map((v) => (/^\d+$/.test(v) ? Number(v) : NaN));
  const problem = scryptParamsProblem({ N, r, p });
  if (problem) return { error: problem };
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || expected.length === 0) return { error: 'empty salt or hash' };
  return { params: { N, r, p }, salt, expected };
}

/**
 * @param {string} password
 * @param {{ N: number, r: number, p: number }} [params] defaults to SCRYPT_PARAMS; tests pass
 *   cheaper ones to stay fast
 */
export async function hashPassword(password, params = SCRYPT_PARAMS) {
  const problem = scryptParamsProblem(params);
  if (problem) throw new Error(`invalid scrypt parameters: ${problem}`);
  const { N, r, p } = params;
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: maxmemFor(params) });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string') return false;
  const parsed = parseScryptHash(stored);
  if (parsed.error) return false;
  const { params, salt, expected } = parsed;
  try {
    const actual = await scrypt(password, salt, expected.length, {
      ...params,
      maxmem: maxmemFor(params),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export const NICKNAME_MAX_LENGTH = 20;

/**
 * Normalize a guest nickname: NFC, no control/format characters (incl. bidi overrides; the
 * zero-width joiner stays for emoji sequences), single spaces, 1..20 characters.
 * Returns null if nothing usable remains.
 */
export function normalizeNickname(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const cleaned = value
    .normalize('NFC')
    .replace(/\s+/gv, ' ')
    .replace(/[[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]--[\u200D]]/gv, '')
    .replace(/ {2,}/gv, ' ')
    .trim();
  const length = [...cleaned].length;
  return length >= 1 && length <= NICKNAME_MAX_LENGTH ? cleaned : null;
}

export const ROLES = new Set(['guest', 'admin']);

/**
 * @param {{ deviceId: string, nickname: string, role: 'guest'|'admin', exp: number }} session
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
  if (
    !session ||
    typeof session.deviceId !== 'string' ||
    typeof session.nickname !== 'string' ||
    !ROLES.has(session.role) ||
    typeof session.exp !== 'number'
  ) {
    return null;
  }
  if (session.exp <= now) return null;
  return session;
}

export function newDeviceId() {
  return crypto.randomUUID();
}
