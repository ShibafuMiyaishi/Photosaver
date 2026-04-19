// album-guard/src/index.js
// Express 配線 + album-guard 独自エンドポイント + Immich プロキシ連結。

const express = require('express');
const morgan = require('morgan');

let config;
try {
  config = require('./config');
} catch (e) {
  if (e.code === 'INVALID_JWT_SECRET') {
    console.error(`[album-guard] FATAL: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const auth = require('./auth');
const { albumAuthMiddleware, immichProxy } = require('./proxy');
const { renderLoginPage } = require('./pages/login');
const { renderInjectScript } = require('./pages/inject');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Morgan: sanitize Authorization / X-Album-Token so tokens never hit logs ---
morgan.token('sanitized-auth', (req) => {
  const h = req.headers.authorization;
  if (!h) return '-';
  return h.toLowerCase().startsWith('bearer ') ? 'Bearer[redacted]' : '[redacted]';
});
morgan.token('sanitized-album-token', (req) =>
  req.headers['x-album-token'] ? '[redacted]' : '-',
);
const SAFE_COMBINED =
  ':remote-addr - :method :url :status :res[content-length] ' +
  '":referrer" ":user-agent" auth=:sanitized-auth album=:sanitized-album-token';
const FORMAT = config.LOG_FORMAT === 'combined' ? SAFE_COMBINED : config.LOG_FORMAT;
app.use(morgan(FORMAT));

// ============================================================
// album-guard 独自エンドポイント
// ============================================================

app.get('/album-guard/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.post('/album-guard/auth', async (req, res) => {
  const { albumId, password } = req.body || {};
  if (!albumId || !password) {
    return res.status(400).json({ error: 'albumId と password が必要です' });
  }
  if (typeof albumId !== 'string' || !UUID_RE.test(albumId)) {
    return res.status(400).json({ error: 'albumId は UUID 形式である必要があります' });
  }

  const token = await auth.verifyPasswordAndSign(albumId, password);
  if (!token) {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  return res.json({
    token,
    albumId,
    message:
      'このトークンを X-Album-Token ヘッダーに付けて Immich API を呼び出してください',
  });
});

app.post('/album-guard/hash', async (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'password が必要です' });
  }
  const hash = await auth.hashPassword(password);
  return res.json({
    hash,
    usage: 'album-passwords.json の hash フィールドに貼り付けてください',
  });
});

app.get('/album-guard/login', (req, res) => {
  const { albumId } = req.query;
  if (!albumId || typeof albumId !== 'string' || !UUID_RE.test(albumId)) {
    return res.status(400).send('albumId パラメータ(UUID 形式)が必要です');
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(renderLoginPage(albumId));
});

app.get('/album-guard/inject.js', (_req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.send(renderInjectScript());
});

// ============================================================
// アルバム API 認証ゲート + Immich 透過プロキシ
// ============================================================
app.use('/api/albums', albumAuthMiddleware, immichProxy);

// その他全リクエストは Immich にそのまま転送。
app.use('/', immichProxy);

// ============================================================
// Start
// ============================================================
function start(port = config.PORT) {
  return app.listen(port, () => {
    const actual = typeof port === 'number' && port !== 0 ? port : 'random';
    console.log(`[album-guard] 起動完了 port:${actual}`);
    console.log(`[album-guard] Immich 転送先: ${config.IMMICH_URL}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
