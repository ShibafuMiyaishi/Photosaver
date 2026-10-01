// guest-gateway/src/config.js
// 環境変数の読み込みと起動時バリデーション。不正なら throw し、index.js が終了させる。

const GIB = 1024 ** 3;

const PLACEHOLDERS = new Set(['', 'CHANGE_ME', 'CHANGE_ME_64_HEX']);

function fail(message) {
  const err = new Error(message);
  err.code = 'INVALID_CONFIG';
  return err;
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
}

function parsePositiveNumber(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw fail(`${name} must be a positive number`);
  return n;
}

/**
 * Build the runtime config from an env-like object.
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (PLACEHOLDERS.has(sessionSecret) || sessionSecret.length < 32) {
    throw fail('SESSION_SECRET is missing or shorter than 32 chars (openssl rand -hex 32)');
  }

  const guestPasswordHash = env.GUEST_PASSWORD_HASH ?? '';
  if (!guestPasswordHash.startsWith('scrypt:')) {
    throw fail('GUEST_PASSWORD_HASH is missing or not a scrypt hash (scripts/hash-password.js)');
  }

  const closesAt = Date.parse(env.CLOSES_AT ?? '');
  if (!Number.isFinite(closesAt)) {
    throw fail('CLOSES_AT must be an ISO-8601 date-time with timezone');
  }

  const stagingDir = env.STAGING_DIR ?? '';
  if (!stagingDir) throw fail('STAGING_DIR is required');

  const port = parsePositiveNumber('PORT', env.PORT, 8080);

  return {
    host: env.HOST || '127.0.0.1',
    port,
    sessionSecret,
    guestPasswordHash,
    closesAt,
    stagingDir,
    // Container path of the HDD mount marker file; empty disables the check (local dev/tests).
    mountMarker: env.MOUNT_MARKER ?? '',
    maxFileBytes: parsePositiveNumber('MAX_FILE_GB', env.MAX_FILE_GB, 4) * GIB,
    minFreeBytes: parsePositiveNumber('MIN_FREE_GB', env.MIN_FREE_GB, 10) * GIB,
    keepUploads: parseBool(env.KEEP_UPLOADS, false),
    cookieSecure: parseBool(env.COOKIE_SECURE, true),
    trustProxyHops: parsePositiveNumber('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS, 1),
  };
}
