// guest-gateway/test/helpers/server.js
// テスト用にアプリを空きポートで起動する。ステージング先はリポジトリ直下の tmp/ 配下。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';

export const TMP_ROOT = path.resolve(import.meta.dirname, '../../../tmp/test-output/guest-gateway');
export const PASSWORD = 'correct horse battery';
export const NICKNAME = 'テスト太郎';

let cachedHash;

/**
 * @param {object} [overrides] config fields to replace
 * @param {Parameters<typeof createApp>[1]} [deps] store/importer for import mode
 */
export async function startServer(overrides = {}, deps = {}) {
  cachedHash ??= await hashPassword(PASSWORD);
  const stagingDir = path.join(TMP_ROOT, crypto.randomUUID());
  await fs.mkdir(stagingDir, { recursive: true });
  const config = {
    ...loadConfig({
      SESSION_SECRET: 'x'.repeat(64),
      GUEST_PASSWORD_HASH: cachedHash,
      CLOSES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      STAGING_DIR: stagingDir,
      COOKIE_SECURE: 'false',
      MIN_FREE_GB: '0.001',
    }),
    ...overrides,
  };
  const { app, tusServer } = createApp(config, deps);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    stagingDir,
    config,
    tusServer,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(stagingDir, { recursive: true, force: true });
    },
  };
}

export async function login(baseUrl, password = PASSWORD, nickname = NICKNAME) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'guest-gateway' },
    body: JSON.stringify({ password, nickname }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { res, cookie: setCookie.split(';')[0] };
}
