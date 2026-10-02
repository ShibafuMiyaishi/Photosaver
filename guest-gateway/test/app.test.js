// guest-gateway/test/app.test.js
// 実アプリを起動し、HTTP と tus(tus-js-client の Node 版)で受入条件を確認する。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import * as tus from 'tus-js-client';
import { vi } from 'vitest';
import { handleError } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { FAST_SCRYPT, login, PASSWORD, startServer, TMP_ROOT } from './helpers/server.js';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const CSRF = { 'X-Requested-With': 'guest-gateway' };

function tusUpload(baseUrl, cookie, data, filename) {
  return new Promise((resolve) => {
    const upload = new tus.Upload(data, {
      endpoint: `${baseUrl}/files/`,
      headers: { ...CSRF, Cookie: cookie },
      metadata: { filename, filetype: 'application/octet-stream' },
      uploadSize: data.length,
      retryDelays: [],
      onSuccess: ({ lastResponse }) =>
        resolve({ ok: true, detected: lastResponse.getHeader('X-GW-Detected-Type') }),
      onError: (err) => resolve({ ok: false, status: err.originalResponse?.getStatus() }),
    });
    upload.start();
  });
}

// Login request that announces a 50-byte JSON body but never sends it.
function stalledLogin(baseUrl) {
  const { hostname, port } = new URL(baseUrl);
  const req = http.request({
    hostname,
    port,
    path: '/api/login',
    method: 'POST',
    agent: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': '50', ...CSRF },
  });
  // Destroying a pending request emits an error; the tests only care about the server side.
  req.on('error', () => {});
  req.flushHeaders();
  const response = new Promise((resolve) => req.on('response', resolve));
  return { req, response };
}

describe('open gateway', () => {
  let srv;
  beforeEach(async () => {
    srv = await startServer();
  });
  afterEach(async () => {
    await srv.close();
  });

  it('serves health, robots and noindex headers', async () => {
    const health = await fetch(`${srv.baseUrl}/healthz`);
    expect(await health.text()).toBe('ok');
    const robots = await fetch(`${srv.baseUrl}/robots.txt`);
    expect(await robots.text()).toContain('Disallow: /');
    expect(robots.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('reports an unauthenticated session', async () => {
    const res = await fetch(`${srv.baseUrl}/api/session`);
    expect(await res.json()).toMatchObject({ authenticated: false });
  });

  it('requires the CSRF header on login', async () => {
    const res = await fetch(`${srv.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'whatever' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a wrong password and accepts the right one', async () => {
    const wrong = await login(srv.baseUrl, 'nope');
    expect(wrong.res.status).toBe(401);
    const ok = await login(srv.baseUrl);
    expect(ok.res.status).toBe(200);
    expect(ok.res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    const session = await fetch(`${srv.baseUrl}/api/session`, { headers: { Cookie: ok.cookie } });
    expect(await session.json()).toMatchObject({ authenticated: true });
  });

  it('requires a usable nickname and does not count it as a failed attempt', async () => {
    for (const nickname of ['', '   ', 'x'.repeat(21), null]) {
      const res = await login(srv.baseUrl, PASSWORD, nickname);
      expect(res.res.status).toBe(400);
      expect(await res.res.json()).toEqual({ error: 'bad_nickname' });
    }
    for (let i = 0; i < 5; i += 1) await login(srv.baseUrl, PASSWORD, '');
    const ok = await login(srv.baseUrl, PASSWORD, '  花子\u202E ');
    expect(ok.res.status).toBe(200);
    // The response carries the server-normalized nickname the session holds.
    expect(await ok.res.json()).toEqual({ ok: true, role: 'guest', nickname: '花子' });
    const session = await fetch(`${srv.baseUrl}/api/session`, { headers: { Cookie: ok.cookie } });
    expect(await session.json()).toMatchObject({
      authenticated: true,
      nickname: '花子',
      importing: false,
    });
  });

  it('lists no import status in the speed-test mode', async () => {
    const { cookie } = await login(srv.baseUrl);
    const res = await fetch(`${srv.baseUrl}/api/uploads`, { headers: { Cookie: cookie } });
    expect(await res.json()).toEqual({ uploads: [] });
    const anonymous = await fetch(`${srv.baseUrl}/api/uploads`);
    expect(anonymous.status).toBe(401);
  });

  it('rejects malformed login bodies with 400', async () => {
    const res = await fetch(`${srv.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CSRF },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('locks out an address after 20 wrong passwords, even for the right one', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await login(srv.baseUrl, `wrong-${i}`)).res.status).toBe(401);
    }
    const next = await login(srv.baseUrl, 'wrong-20');
    expect(next.res.status).toBe(429);
    expect(await next.res.json()).toEqual({ error: 'too_many_attempts' });
    expect(next.res.headers.get('retry-after')).toBe('120');
    const correct = await login(srv.baseUrl);
    expect(correct.res.status).toBe(429);
    expect(correct.cookie).toBe('');
  });

  it('does not let parallel wrong passwords bypass the lockout', async () => {
    const burst = await Promise.all(
      Array.from({ length: 30 }, (_, i) => login(srv.baseUrl, `parallel-${i}`)),
    );
    const statuses = burst.map(({ res }) => res.status);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    let failures = statuses.filter((s) => s === 401).length;
    expect(failures).toBeLessThanOrEqual(20);
    expect(burst.every(({ cookie }) => cookie === '')).toBe(true);

    // Sequential wrong attempts still lock exactly at the 20th recorded failure.
    while (failures < 20) {
      expect((await login(srv.baseUrl, `sequential-${failures}`)).res.status).toBe(401);
      failures += 1;
    }
    const locked = await login(srv.baseUrl, 'one-more');
    expect(locked.res.status).toBe(429);
    expect(await locked.res.json()).toEqual({ error: 'too_many_attempts' });
    const correct = await login(srv.baseUrl);
    expect(correct.res.status).toBe(429);
    expect(correct.res.headers.get('set-cookie')).toBeNull();
  });

  it('does not let stalled login bodies hold attempt slots', async () => {
    const stalled = Array.from({ length: 9 }, () => stalledLogin(srv.baseUrl));
    try {
      // Let the server receive all nine sets of headers before the real login.
      await delay(200);
      const ok = await login(srv.baseUrl);
      expect(ok.res.status).toBe(200);
      expect(ok.cookie).not.toBe('');
    } finally {
      for (const { req } of stalled) req.destroy();
    }
  });

  it('ignores successful logins in the outer rate limit', { timeout: 30_000 }, async () => {
    for (let i = 0; i < 31; i += 1) {
      expect((await login(srv.baseUrl)).res.status).toBe(200);
    }
  });

  it('refuses uploads without a session', async () => {
    const result = await tusUpload(srv.baseUrl, '', PNG, 'a.png');
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('accepts a real image, reports its detected type and clears staging', async () => {
    const { cookie } = await login(srv.baseUrl);
    const result = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0001.png');
    expect(result).toEqual({ ok: true, detected: 'image/png' });
    expect(await fs.readdir(srv.stagingDir)).toEqual([]);
  });

  it('rejects disallowed extensions at creation', async () => {
    const { cookie } = await login(srv.baseUrl);
    const result = await tusUpload(srv.baseUrl, cookie, Buffer.from('<svg/>'), 'evil.svg');
    expect(result).toEqual({ ok: false, status: 415 });
  });

  it('rejects files whose content is not a photo or video', async () => {
    const { cookie } = await login(srv.baseUrl);
    const result = await tusUpload(srv.baseUrl, cookie, Buffer.from('just text'), 'fake.jpg');
    expect(result).toEqual({ ok: false, status: 415 });
    expect(await fs.readdir(srv.stagingDir)).toEqual([]);
  });

  it('does not let tus serve staged files back', async () => {
    const { cookie } = await login(srv.baseUrl);
    const res = await fetch(`${srv.baseUrl}/files/abc123`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('serves only the listed PhotoSwipe files from node_modules', async () => {
    const lightbox = await fetch(`${srv.baseUrl}/vendor/photoswipe/photoswipe-lightbox.esm.min.js`);
    expect(lightbox.status).toBe(200);
    expect(lightbox.headers.get('content-type')).toMatch(/javascript/);
    const css = await fetch(`${srv.baseUrl}/vendor/photoswipe/photoswipe.css`);
    expect(css.headers.get('content-type')).toMatch(/css/);
    for (const name of [
      'package.json',
      '..%2F..%2Fpackage.json',
      'photoswipe.esm.js.map',
      'toString',
    ]) {
      expect((await fetch(`${srv.baseUrl}/vendor/photoswipe/${name}`)).status).toBe(404);
    }
  });

  it('shows the client address for diagnostics', async () => {
    const { cookie } = await login(srv.baseUrl);
    const res = await fetch(`${srv.baseUrl}/api/whoami`, { headers: { Cookie: cookie } });
    expect(await res.json()).toMatchObject({ viaFunnel: false });
  });
});

describe('login lockout tuning', () => {
  let srv;
  beforeEach(async () => {
    // LOGIN_MAX_FAILURES=2, a lock of 0.6 s instead of minutes.
    srv = await startServer({ loginMaxFailures: 2, loginLockMs: 600 });
  });
  afterEach(async () => {
    await srv.close();
  });

  it('uses the configured threshold and lets a venue back in once the lock ends', async () => {
    for (let i = 0; i < 2; i += 1) {
      expect((await login(srv.baseUrl, `wrong-${i}`)).res.status).toBe(401);
    }
    const locked = await login(srv.baseUrl);
    expect(locked.res.status).toBe(429);
    expect(locked.res.headers.get('retry-after')).toBe('1');
    // Guests behind the same NAT keep trying while it is locked: these refusals must not
    // add up in the outer rate limit (30) and extend the lock to 15 minutes.
    for (let i = 0; i < 35; i += 1) {
      expect((await login(srv.baseUrl, `retry-${i}`)).res.status).toBe(429);
    }
    await delay(700);
    expect((await login(srv.baseUrl)).res.status).toBe(200);
  });

  it('still counts malformed requests in the outer rate limit (30 per window)', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await login(srv.baseUrl, PASSWORD, '')).res.status).toBe(400);
    }
    expect((await login(srv.baseUrl, PASSWORD, '')).res.status).toBe(429);
    // The limit is per address, so it blocks valid logins from there too.
    expect((await login(srv.baseUrl)).res.status).toBe(429);
  });
});

describe('admin password under guessing', () => {
  const ADMIN_PASSWORD = 'organiser only 42';
  let srv;
  let t;
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    t = Date.now();
    srv = await startServer(
      { adminPasswordHash: await hashPassword(ADMIN_PASSWORD, FAST_SCRYPT) },
      // 6 failed logins per 15 minutes pause the admin check (300 in production).
      { lockoutOptions: { adminGuessLimit: 6, now: () => t } },
    );
  });
  afterEach(async () => {
    await srv.close();
    vi.restoreAllMocks();
  });

  it('stops checking the admin password while too many logins fail, guests unaffected', async () => {
    // A guest-password holder alternates a correct login (trusted key, failures cleared) with
    // wrong guesses: never locked, but each failure from its trusted key feeds the admin-guess
    // window.
    for (let round = 0; round < 2; round += 1) {
      expect((await login(srv.baseUrl)).res.status).toBe(200);
      for (let i = 0; i < 3; i += 1) {
        expect((await login(srv.baseUrl, `admin-guess-${round}-${i}`)).res.status).toBe(401);
      }
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('admin_check_paused'));
    // Even the right admin password now fails like a wrong one...
    const admin = await login(srv.baseUrl, ADMIN_PASSWORD, '幹事');
    expect(admin.res.status).toBe(401);
    expect(await admin.res.json()).toEqual({ error: 'wrong_password' });
    // ...while the guest password still works.
    const guest = await login(srv.baseUrl);
    expect(await guest.res.json()).toMatchObject({ ok: true, role: 'guest' });
    // Once the failures have left the 15-minute window, the organiser gets in again.
    t += 15 * 60 * 1000;
    const later = await login(srv.baseUrl, ADMIN_PASSWORD, '幹事');
    expect(await later.res.json()).toMatchObject({ ok: true, role: 'admin' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('admin_check_resumed'));
  });

  it('keeps checking the admin password when only untrusted clients fail', async () => {
    // No guest login first: the address is untrusted, so its failures do not count.
    for (let i = 0; i < 10; i += 1) {
      expect((await login(srv.baseUrl, `anon-guess-${i}`)).res.status).toBe(401);
    }
    const admin = await login(srv.baseUrl, ADMIN_PASSWORD, '幹事');
    expect(await admin.res.json()).toMatchObject({ ok: true, role: 'admin' });
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('admin_check_paused'));
  });
});

describe('tus route query strings', () => {
  let srv;
  beforeEach(async () => {
    srv = await startServer();
  });
  afterEach(async () => {
    await srv.close();
  });

  it('rejects any /files request with a query string before tus sees it', async () => {
    const { cookie } = await login(srv.baseUrl);
    const headers = { ...CSRF, Cookie: cookie, 'Tus-Resumable': '1.0.0' };
    for (const [method, url] of [
      ['POST', '/files?x=1'],
      ['POST', '/files/?'],
      ['PATCH', '/files/abc123?id=other'],
      ['GET', '/files/abc123?x'],
    ]) {
      const res = await fetch(`${srv.baseUrl}${url}`, { method, headers });
      expect(res.status, `${method} ${url}`).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    const head = await fetch(`${srv.baseUrl}/files/abc123?x`, { method: 'HEAD', headers });
    expect(head.status).toBe(400);
    // Without a session too: the query is refused first.
    const anon = await fetch(`${srv.baseUrl}/files/?x`, { method: 'POST', headers: CSRF });
    expect(anon.status).toBe(400);
  });
});

describe('login body deadline', () => {
  let srv;
  beforeEach(async () => {
    srv = await startServer({ loginBodyTimeoutMs: 200 });
  });
  afterEach(async () => {
    await srv.close();
  });

  it('answers a stalled body with 408 and closes the connection', async () => {
    const { req, response } = stalledLogin(srv.baseUrl);
    const closed = new Promise((resolve) => req.on('close', resolve));
    try {
      const res = await response;
      expect(res.statusCode).toBe(408);
      let body = '';
      res.setEncoding('utf8');
      for await (const chunk of res) body += chunk;
      expect(JSON.parse(body)).toEqual({ error: 'timeout' });
      await closed;
    } finally {
      req.destroy();
    }
    // A normal login still works afterwards.
    expect((await login(srv.baseUrl)).res.status).toBe(200);
  });
});

describe('upload storage safety', () => {
  let srv;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it('refuses uploads with 503 when the HDD mount marker is missing', async () => {
    srv = await startServer({ mountMarker: path.join(TMP_ROOT, 'missing.mount-ok') });
    const { cookie } = await login(srv.baseUrl);
    const result = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0001.png');
    expect(result).toEqual({ ok: false, status: 503 });
  });

  it('accepts uploads when the HDD mount marker exists', async () => {
    const marker = path.join(TMP_ROOT, `${crypto.randomUUID()}.mount-ok`);
    await fs.mkdir(TMP_ROOT, { recursive: true });
    await fs.writeFile(marker, '');
    try {
      srv = await startServer({ mountMarker: marker });
      const { cookie } = await login(srv.baseUrl);
      const result = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0001.png');
      expect(result).toEqual({ ok: true, detected: 'image/png' });
    } finally {
      await fs.rm(marker, { force: true });
    }
  });

  it('does not leak internal error details to the client', async () => {
    srv = await startServer();
    const { cookie } = await login(srv.baseUrl);
    // Make fs.statfs fail inside the creation hook.
    await fs.rm(srv.stagingDir, { recursive: true, force: true });
    const res = await fetch(`${srv.baseUrl}/files/`, {
      method: 'POST',
      headers: {
        ...CSRF,
        Cookie: cookie,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(PNG.length),
        'Upload-Metadata': `filename ${Buffer.from('a.png').toString('base64')}`,
      },
    });
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('Storage unavailable');
    expect(body).not.toContain(srv.stagingDir);
    expect(body).not.toMatch(/ENOENT/);
  });

  it('keeps finished files outside the tus area when KEEP_UPLOADS is on', async () => {
    srv = await startServer({ keepUploads: true });
    const { cookie } = await login(srv.baseUrl);
    const result = await tusUpload(srv.baseUrl, cookie, PNG, 'IMG_0001.PNG');
    expect(result).toEqual({ ok: true, detected: 'image/png' });
    expect(await fs.readdir(srv.stagingDir)).toEqual(['kept']);
    const kept = await fs.readdir(path.join(srv.stagingDir, 'kept'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^[A-Za-z0-9_-]+\.png$/);
    // Expiry cleanup only sees tus entries (file + .json), so the kept file survives.
    await srv.tusServer.cleanUpExpiredUploads();
    expect(await fs.readdir(path.join(srv.stagingDir, 'kept'))).toEqual(kept);
  });
});

describe('closed gateway', () => {
  let srv;
  beforeAll(async () => {
    srv = await startServer({ closesAt: Date.now() - 1000 });
  });
  afterAll(async () => {
    await srv.close();
  });

  it('returns 410 everywhere except the health check', async () => {
    expect((await fetch(`${srv.baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${srv.baseUrl}/api/session`)).status).toBe(410);
    expect((await fetch(`${srv.baseUrl}/`)).status).toBe(410);
    const upload = await fetch(`${srv.baseUrl}/files/`, {
      method: 'POST',
      headers: { ...CSRF, 'Tus-Resumable': '1.0.0', 'Upload-Length': '10' },
    });
    expect(upload.status).toBe(410);
  });
});

describe('final error handler', () => {
  function fakeRes(headersSent) {
    const res = { headersSent, statusCode: 200, body: undefined };
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (body) => {
      res.body = body;
      return res;
    };
    return res;
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers without details before the response has started', () => {
    const next = vi.fn();
    const res = fakeRes(false);
    handleError(new Error('/srv/internal/path exploded'), { path: '/x' }, res, next);
    expect(res).toMatchObject({ statusCode: 500, body: { error: 'internal' } });
    const tooLarge = fakeRes(false);
    handleError(
      Object.assign(new Error('too large'), { status: 413 }),
      { path: '/x' },
      tooLarge,
      next,
    );
    expect(tooLarge).toMatchObject({ statusCode: 413, body: { error: 'bad_request' } });
    expect(next).not.toHaveBeenCalled();
  });

  it('hands a mid-response error to Express, which closes the connection', async () => {
    const app = express();
    app.get('/partial', (_req, res, next) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '100' });
      res.write('only part of it');
      next(new Error('upstream stream failed'));
    });
    app.use(handleError);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/partial`);
      expect(res.status).toBe(200);
      // The body is cut off, not silently completed.
      await expect(res.arrayBuffer()).rejects.toThrow();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
