// guest-gateway/test/app.test.js
// 実アプリを起動し、HTTP と tus(tus-js-client の Node 版)で受入条件を確認する。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as tus from 'tus-js-client';
import { login, startServer, TMP_ROOT } from './helpers/server.js';

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

  it('rejects malformed login bodies with 400', async () => {
    const res = await fetch(`${srv.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CSRF },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('locks out an address after 5 wrong passwords, even for the right one', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await login(srv.baseUrl, `wrong-${i}`)).res.status).toBe(401);
    }
    const sixth = await login(srv.baseUrl, 'wrong-5');
    expect(sixth.res.status).toBe(429);
    expect(await sixth.res.json()).toEqual({ error: 'too_many_attempts' });
    expect(sixth.res.headers.get('retry-after')).toBe('900');
    const correct = await login(srv.baseUrl);
    expect(correct.res.status).toBe(429);
    expect(correct.cookie).toBe('');
  });

  it('does not let parallel wrong passwords bypass the lockout', async () => {
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => login(srv.baseUrl, `parallel-${i}`)),
    );
    const statuses = burst.map(({ res }) => res.status);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    let failures = statuses.filter((s) => s === 401).length;
    expect(failures).toBeLessThanOrEqual(5);
    expect(burst.every(({ cookie }) => cookie === '')).toBe(true);

    // Sequential wrong attempts still lock exactly at the 5th recorded failure.
    while (failures < 5) {
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

  it('shows the client address for diagnostics', async () => {
    const { cookie } = await login(srv.baseUrl);
    const res = await fetch(`${srv.baseUrl}/api/whoami`, { headers: { Cookie: cookie } });
    expect(await res.json()).toMatchObject({ viaFunnel: false });
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
