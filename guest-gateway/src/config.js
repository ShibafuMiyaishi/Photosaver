// guest-gateway/src/config.js
// 環境変数の読み込みと起動時バリデーション。不正なら throw し、index.js が終了させる。
// IMMICH_SHARE_KEY が空なら速度検証モード(受信のみ・Immich へは取り込まない)。

const GIB = 1024 ** 3;

const PLACEHOLDERS = new Set(['', 'CHANGE_ME', 'CHANGE_ME_64_HEX']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Immich import settings, or null in speed-test mode (no share key). */
function loadImmich(env) {
  const shareKey = env.IMMICH_SHARE_KEY ?? '';
  if (shareKey === '') return null;
  if (PLACEHOLDERS.has(shareKey)) throw fail('IMMICH_SHARE_KEY is still a placeholder');

  let baseUrl;
  try {
    baseUrl = new URL(env.IMMICH_URL || 'http://immich-server:2283');
  } catch {
    throw fail('IMMICH_URL must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw fail('IMMICH_URL must be an absolute http(s) URL');
  }

  const albumId = env.IMMICH_ALBUM_ID ?? '';
  if (!UUID.test(albumId)) throw fail('IMMICH_ALBUM_ID must be the album UUID');

  const dbPath = env.DB_PATH ?? '';
  if (!dbPath) throw fail('DB_PATH is required when IMMICH_SHARE_KEY is set');

  return {
    baseUrl: baseUrl.href,
    shareKey,
    albumId,
    // Used by the delete feature; optional until then.
    deleteApiKey: env.IMMICH_DELETE_API_KEY || '',
    dbPath,
  };
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
    // Speed-test mode only: keep received files instead of deleting them.
    keepUploads: parseBool(env.KEEP_UPLOADS, false),
    immich: loadImmich(env),
    cookieSecure: parseBool(env.COOKIE_SECURE, true),
    trustProxyHops: parsePositiveNumber('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS, 1),
  };
}
