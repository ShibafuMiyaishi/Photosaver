// album-guard/src/proxy.js
// /api/albums/:uuid* を検出してトークン検証、通過時は Immich に透過プロキシ。

const { createProxyMiddleware } = require('http-proxy-middleware');
const auth = require('./auth');
const config = require('./config');

// 完全な UUID 形式(8-4-4-4-12 hex)かつ /api/albums/ 直下に限定。
// 末尾は / か 文字列末でなければならない(`/api/albumsextra/...` 等を誤マッチしない)。
const ALBUM_PATH_RE =
  /^\/api\/albums\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

function extractAlbumId(url) {
  const m = url.match(ALBUM_PATH_RE);
  return m ? m[1] : null;
}

function extractToken(req) {
  if (req.headers['x-album-token']) return req.headers['x-album-token'];
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function setNoCache(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

function albumAuthMiddleware(req, res, next) {
  const albumId = extractAlbumId(req.path);
  if (!albumId || !auth.isProtected(albumId)) return next();

  const token = extractToken(req);
  if (!token || !auth.verifyToken(token, albumId)) {
    setNoCache(res);
    return res.status(401).json({
      error: 'Album is password protected',
      albumId,
      message:
        'POST /album-guard/auth でパスワード認証を行い、X-Album-Token ヘッダーにトークンを付けてください',
    });
  }
  return next();
}

function makeRequestId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const immichProxy = createProxyMiddleware({
  target: config.IMMICH_URL,
  changeOrigin: true,
  xfwd: true,
  ws: false,
  on: {
    error: (err, _req, res) => {
      const rid = makeRequestId();
      console.error(
        `[album-guard] proxy error rid=${rid} code=${err.code || 'UNKNOWN'} msg=${err.message}`,
      );
      if (!res || res.headersSent) return;
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        // Immich がまだ起動中 / migration 中 → graceful retry を促す。
        res.setHeader('Retry-After', '5');
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Upstream not ready',
            rid,
            message: 'Immich が起動中です。数秒後に再試行してください。',
          }),
        );
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad gateway', rid }));
      }
    },
  },
});

module.exports = {
  albumAuthMiddleware,
  immichProxy,
  extractAlbumId,
  extractToken,
};
