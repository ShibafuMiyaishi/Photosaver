// guest-gateway/test/login-unavailable.test.js
// scrypt 自体の失敗(メモリ不足など)は誤った合言葉として数えず、503 を返して照合枠を返すことを確認する。

import { vi } from 'vitest';
import { login, startServer } from './helpers/server.js';

const scryptBroken = vi.hoisted(() => ({ on: false }));

vi.mock('../src/auth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    async verifyPassword(...args) {
      if (scryptBroken.on) throw new Error('scrypt failed: out of memory');
      return actual.verifyPassword(...args);
    },
  };
});

describe('login when the password check itself fails', () => {
  let srv;
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Two recorded failures would lock the address.
    srv = await startServer({ loginMaxFailures: 2 });
  });
  afterEach(async () => {
    scryptBroken.on = false;
    await srv.close();
    vi.restoreAllMocks();
  });

  it('answers 503 without counting a failure and frees the attempt slot', async () => {
    scryptBroken.on = true;
    for (let i = 0; i < 3; i += 1) {
      const { res, cookie } = await login(srv.baseUrl);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'unavailable' });
      expect(cookie).toBe('');
    }
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('login_check_failed'));
    scryptBroken.on = false;
    // Not locked (no failure recorded) and not 'busy' (the slot was released).
    const ok = await login(srv.baseUrl);
    expect(ok.res.status).toBe(200);
  });
});
