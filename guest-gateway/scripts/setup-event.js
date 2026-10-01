// guest-gateway/scripts/setup-event.js
// イベント用の Immich 側の準備を自動化する: 結婚式専用ユーザー → アルバム(管理者を編集者として招待)
// → 共有リンク(アップロード/ダウンロード許可・期限付き・パスワードなし)→ 削除専用 API キー。
// 秘密情報(共有リンクキー・API キー・専用ユーザーのパスワード)は権限 600 のファイルにだけ書き出す。
//
// 使い方(管理者のパスワードはシェル履歴に残さない):
//   read -rs IMMICH_ADMIN_PASSWORD && export IMMICH_ADMIN_PASSWORD
//   IMMICH_URL=http://127.0.0.1:2283 IMMICH_ADMIN_EMAIL=<管理者メール> \
//     node scripts/setup-event.js --name "<アルバム名>" --event-email <専用ユーザーのメール> \
//       --expires 2026-10-31T23:59:00+09:00 --out /srv/photosaver/guest-gateway/immich.env
//   unset IMMICH_ADMIN_PASSWORD
// 開発用 Immich(未初期化)では --dev-init-admin を付けると、最初の管理者も作る。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MIN_VERSION = [3, 2, 4];

class SetupError extends Error {}

function versionAtLeast({ major, minor, patch }, [a, b, c]) {
  if (major !== a) return major > a;
  if (minor !== b) return minor > b;
  return patch >= c;
}

function createApi(baseUrl, fetchImpl) {
  const root = new URL('/api/', baseUrl);
  return async function api(step, path, { method = 'GET', token, json } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(new URL(path, root), {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new SetupError(`${step} failed (HTTP ${res.status})`);
    }
    return res.status === 204 ? null : res.json();
  };
}

/**
 * @param {{
 *   baseUrl: string, adminEmail: string, adminPassword: string, albumName: string,
 *   eventEmail: string, expiresAt: string, devInitAdmin?: boolean, fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ albumId: string, shareKey: string, deleteApiKey: string,
 *   eventEmail: string, eventPassword: string }>}
 */
export async function setupEvent({
  baseUrl,
  adminEmail,
  adminPassword,
  albumName,
  eventEmail,
  expiresAt,
  devInitAdmin = false,
  fetchImpl = fetch,
}) {
  const api = createApi(baseUrl, fetchImpl);

  const version = await api('version check', 'server/version');
  if (!versionAtLeast(version, MIN_VERSION)) {
    throw new SetupError(
      `Immich ${version.major}.${version.minor}.${version.patch} is too old; need >= 3.2.4 (GHSA-q89f-h332-8q2h)`,
    );
  }

  const config = await api('server config', 'server/config');
  if (!config.isInitialized) {
    if (!devInitAdmin)
      throw new SetupError('Immich has no admin yet (use --dev-init-admin for dev)');
    await api('admin sign-up', 'auth/admin-sign-up', {
      method: 'POST',
      json: { email: adminEmail, password: adminPassword, name: 'Admin' },
    });
  }

  const admin = await api('admin login', 'auth/login', {
    method: 'POST',
    json: { email: adminEmail, password: adminPassword },
  });
  if (!admin.isAdmin) throw new SetupError('the given account is not an Immich admin');

  const eventPassword = crypto.randomBytes(24).toString('base64url');
  await api('create event user', 'admin/users', {
    method: 'POST',
    token: admin.accessToken,
    json: {
      email: eventEmail,
      password: eventPassword,
      name: albumName,
      shouldChangePassword: false,
      quotaSizeInBytes: null,
    },
  });

  const eventUser = await api('event user login', 'auth/login', {
    method: 'POST',
    json: { email: eventEmail, password: eventPassword },
  });

  const album = await api('create album', 'albums', {
    method: 'POST',
    token: eventUser.accessToken,
    json: { albumName, albumUsers: [{ userId: admin.userId, role: 'editor' }] },
  });

  const link = await api('create shared link', 'shared-links', {
    method: 'POST',
    token: eventUser.accessToken,
    json: {
      type: 'ALBUM',
      albumId: album.id,
      allowUpload: true,
      allowDownload: true,
      showMetadata: true,
      expiresAt,
    },
  });

  const apiKey = await api('create delete API key', 'api-keys', {
    method: 'POST',
    token: eventUser.accessToken,
    json: { name: 'guest-gateway (delete only)', permissions: ['asset.delete'] },
  });

  return {
    albumId: album.id,
    shareKey: link.key,
    deleteApiKey: apiKey.secret,
    eventEmail,
    eventPassword,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      'event-email': { type: 'string' },
      expires: { type: 'string' },
      out: { type: 'string' },
      'dev-init-admin': { type: 'boolean', default: false },
    },
  });
  const baseUrl = process.env.IMMICH_URL || 'http://127.0.0.1:2283';
  const adminEmail = process.env.IMMICH_ADMIN_EMAIL;
  const adminPassword = process.env.IMMICH_ADMIN_PASSWORD;
  const expiresMs = Date.parse(values.expires ?? '');

  if (!values.name || !values['event-email'] || !values.out || !Number.isFinite(expiresMs)) {
    throw new SetupError(
      'required: --name, --event-email, --expires <ISO date-time>, --out <file>',
    );
  }
  if (!adminEmail || !adminPassword) {
    throw new SetupError('set IMMICH_ADMIN_EMAIL and IMMICH_ADMIN_PASSWORD in the environment');
  }
  // Refuse to clobber an earlier result before touching Immich.
  await fs.access(values.out).then(
    () => {
      throw new SetupError(`${values.out} already exists; refusing to overwrite`);
    },
    () => {},
  );

  const result = await setupEvent({
    baseUrl,
    adminEmail,
    adminPassword,
    albumName: values.name,
    eventEmail: values['event-email'],
    expiresAt: new Date(expiresMs).toISOString(),
    devInitAdmin: values['dev-init-admin'],
  });

  const lines = [
    '# guest-gateway: generated by scripts/setup-event.js — secrets, keep mode 600, never commit',
    `IMMICH_ALBUM_ID=${result.albumId}`,
    `IMMICH_SHARE_KEY=${result.shareKey}`,
    `IMMICH_DELETE_API_KEY=${result.deleteApiKey}`,
    `EVENT_USER_EMAIL=${result.eventEmail}`,
    `EVENT_USER_PASSWORD=${result.eventPassword}`,
    '',
  ];
  await fs.writeFile(values.out, lines.join('\n'), { mode: 0o600, flag: 'wx' });
  console.log(
    `[guest-gateway] event ready: album ${result.albumId}; secrets written to ${values.out}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[guest-gateway] setup failed: ${err instanceof SetupError ? err.message : err}`);
    process.exit(1);
  });
}
