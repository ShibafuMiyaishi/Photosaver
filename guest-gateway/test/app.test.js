// guest-gateway/test/app.test.js
// 実アプリを起動し、HTTP と tus(tus-js-client の Node 版)で受入条件を確認する。

import fs from 'node:fs/promises';
import * as tus from 'tus-js-client';
import { login, startServer } from './helpers/server.js';

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

  it('rate-limits repeated wrong passwords', async () => {
    let last;
    for (let i = 0; i < 11; i += 1) last = await login(srv.baseUrl, `wrong-${i}`);
    expect(last.res.status).toBe(429);
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
