// album-guard/test/config.test.js
// 起動時バリデータと defaults 解決の単体テスト。
// Vitest globals (describe/it/expect/vi/beforeEach/afterAll) は vitest.config.js の
// `globals: true` により自動注入される。
//
// 注意: vi.resetModules() は Vitest の ESM registry を clear するが、CJS テストから
// 呼ばれる Node の require.cache は clear しない。
// そのため毎回 freshRequire() で require.cache を明示的にバストしてから読み込む。

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const k of Object.keys(ORIGINAL_ENV)) {
    process.env[k] = ORIGINAL_ENV[k];
  }
}

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

describe('config', () => {
  beforeEach(() => {
    resetEnv();
  });

  afterAll(() => {
    resetEnv();
  });

  it('throws when GUARD_JWT_SECRET is empty', () => {
    delete process.env.GUARD_JWT_SECRET;
    expect(() => freshRequire('../src/config')).toThrow(/GUARD_JWT_SECRET/);
  });

  it('throws when GUARD_JWT_SECRET is the spec placeholder', () => {
    process.env.GUARD_JWT_SECRET = 'CHANGE_THIS_JWT_SECRET_32chars_min';
    expect(() => freshRequire('../src/config')).toThrow(/GUARD_JWT_SECRET/);
  });

  it('throws when GUARD_JWT_SECRET is shorter than 32 chars', () => {
    process.env.GUARD_JWT_SECRET = 'a'.repeat(31);
    expect(() => freshRequire('../src/config')).toThrow(/32 chars/i);
  });

  it('resolves defaults when JWT is valid', () => {
    process.env.GUARD_JWT_SECRET = 'a'.repeat(64);
    delete process.env.GUARD_PORT;
    delete process.env.IMMICH_INTERNAL_URL;
    delete process.env.GUARD_JWT_EXPIRES_IN;
    delete process.env.GUARD_LOG_FORMAT;
    const c = freshRequire('../src/config');
    expect(c.PORT).toBe(3000);
    expect(c.IMMICH_URL).toBe('http://immich-server:2283');
    expect(c.JWT_EXPIRES_IN).toBe('24h');
    expect(c.LOG_FORMAT).toBe('combined');
  });

  it('honors GUARD_PORT override', () => {
    process.env.GUARD_JWT_SECRET = 'a'.repeat(64);
    process.env.GUARD_PORT = '3001';
    const c = freshRequire('../src/config');
    expect(c.PORT).toBe(3001);
  });
});
