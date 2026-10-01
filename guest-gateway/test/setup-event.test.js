// guest-gateway/test/setup-event.test.js
// 偽の Immich サーバーで、イベント準備スクリプトの入力検証・出力ファイルの先行確保・
// 専用ユーザーのパスワードを書き出さないこと・失敗時の後始末を確認する。

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { runCli, SetupError, validateExpires } from '../scripts/setup-event.js';
import { TMP_ROOT } from './helpers/server.js';

const ALBUM = '11111111-2222-4333-8444-555555555555';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'dev-admin-password-123';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startFakeImmich({ failApiKey = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      const route = `${req.method} ${req.url}`;
      if (route === 'GET /api/server/version') {
        return json(res, 200, { major: 3, minor: 2, patch: 4 });
      }
      if (route === 'GET /api/server/config') return json(res, 200, { isInitialized: true });
      if (route === 'POST /api/auth/login') {
        const isAdmin = body.email === ADMIN_EMAIL;
        return json(res, 201, {
          isAdmin,
          accessToken: isAdmin ? 'admin-token' : 'event-token',
          userId: isAdmin ? 'admin-id' : 'event-id',
        });
      }
      if (route === 'POST /api/admin/users') return json(res, 201, { id: 'event-id' });
      if (route === 'POST /api/albums') return json(res, 201, { id: ALBUM });
      if (route === 'POST /api/shared-links') return json(res, 201, { key: 'share-key-xyz' });
      if (route === 'POST /api/api-keys') {
        return failApiKey ? json(res, 500, {}) : json(res, 201, { secret: 'delete-key-xyz' });
      }
      return json(res, 404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

function futureIso() {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
}

describe('validateExpires', () => {
  const now = Date.UTC(2026, 9, 1);

  it('accepts future date-times with Z or an explicit offset', () => {
    expect(validateExpires('2026-10-31T23:59:00+09:00', now)).toBe('2026-10-31T14:59:00.000Z');
    expect(validateExpires('2026-10-31T14:59Z', now)).toBe('2026-10-31T14:59:00.000Z');
    expect(validateExpires('2026-10-31T14:59:00.500-01:00', now)).toBe('2026-10-31T15:59:00.500Z');
  });

  it('rejects date-only, zone-less, malformed and past values', () => {
    for (const value of [
      undefined,
      '',
      '2026-10-31',
      '2026-10-31T23:59:00',
      '2026-10-31 23:59:00+09:00',
      '2026-10-31T23:59:00+0900',
      'tomorrow',
      '2026-13-01T00:00:00Z',
    ]) {
      expect(() => validateExpires(value, now)).toThrow(SetupError);
    }
    expect(() => validateExpires('2026-09-30T23:59:00Z', now)).toThrow(/future/);
    expect(() => validateExpires('2026-10-01T00:00:00Z', now)).toThrow(/future/);
  });
});

describe('runCli', () => {
  let fake;
  let dir;
  let out;
  let env;
  let calls;
  let fetchImpl;

  beforeEach(async () => {
    dir = path.join(TMP_ROOT, `setup-${crypto.randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    out = path.join(dir, 'immich.env');
    calls = [];
    fetchImpl = (url, init) => {
      // Records whether the output file was already reserved when Immich was first contacted.
      calls.push({ url: String(url), redirect: init?.redirect, outExists: existsSync(out) });
      return fetch(url, init);
    };
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  function args(extra = {}) {
    const opts = {
      '--name': 'Wedding',
      '--event-email': 'event@example.com',
      '--expires': futureIso(),
      '--out': out,
      ...extra,
    };
    return Object.entries(opts).flat();
  }

  async function startWithEnv(options) {
    fake = await startFakeImmich(options);
    env = {
      IMMICH_URL: fake.baseUrl,
      IMMICH_ADMIN_EMAIL: ADMIN_EMAIL,
      IMMICH_ADMIN_PASSWORD: ADMIN_PASSWORD,
    };
  }

  it('reserves the output file first and never writes the event user password', async () => {
    await startWithEnv();
    const logs = [];
    await runCli(args(), env, { fetchImpl, log: (m) => logs.push(m) });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.outExists)).toBe(true);
    expect(calls.every((c) => c.redirect === 'error')).toBe(true);

    const eventPassword = fake.requests.find((r) => r.url === '/api/admin/users').body.password;
    expect(eventPassword).toBeTruthy();
    const content = await fs.readFile(out, 'utf8');
    expect(content).toContain(`IMMICH_ALBUM_ID=${ALBUM}`);
    expect(content).toContain('IMMICH_SHARE_KEY=share-key-xyz');
    expect(content).toContain('IMMICH_DELETE_API_KEY=delete-key-xyz');
    expect(content).toContain('# event user: event@example.com');
    expect(content).not.toMatch(/^EVENT_USER_EMAIL=/m);
    expect(content).not.toMatch(/PASSWORD/);
    expect(content).not.toContain(eventPassword);
    expect(content).not.toContain(ADMIN_PASSWORD);
    expect(logs.join('\n')).not.toContain(eventPassword);
    if (process.platform !== 'win32') {
      expect((await fs.stat(out)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses an existing output file without contacting Immich', async () => {
    await startWithEnv();
    await fs.writeFile(out, 'keep me');
    await expect(runCli(args(), env, { fetchImpl })).rejects.toThrow(/already exists/);
    expect(calls).toHaveLength(0);
    expect(await fs.readFile(out, 'utf8')).toBe('keep me');
  });

  it('fails fast when the output directory is missing', async () => {
    await startWithEnv();
    const missing = path.join(dir, 'no-such-dir', 'immich.env');
    const err = await runCli(args({ '--out': missing }), env, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SetupError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid or past --expires before contacting Immich', async () => {
    await startWithEnv();
    for (const expires of ['2026-10-31', '2026-10-31T23:59:00', '2000-01-01T00:00:00Z']) {
      const err = await runCli(args({ '--expires': expires }), env, { fetchImpl }).catch((e) => e);
      expect(err).toBeInstanceOf(SetupError);
    }
    expect(calls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });

  it('removes the reserved file when setup fails midway', async () => {
    await startWithEnv({ failApiKey: true });
    const err = await runCli(args(), env, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SetupError);
    expect(err.message).toMatch(/delete API key/);
    expect(calls.length).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(false);
  });
});
