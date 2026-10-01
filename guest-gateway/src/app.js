// guest-gateway/src/app.js
// Express アプリの組み立て。公開されるのはここに列挙したルートだけで、それ以外は 404。

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import {
  newDeviceId,
  normalizeNickname,
  signSession,
  verifyPassword,
  verifySession,
} from './auth.js';
import { createGalleryRouter } from './gallery.js';
import { createLockout } from './lockout.js';
import { log } from './log.js';
import { createTusServer } from './uploads.js';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const TUS_CLIENT_PATH = path.join(APP_ROOT, 'node_modules', 'tus-js-client', 'dist', 'tus.min.js');
const PHOTOSWIPE_DIST = path.join(APP_ROOT, 'node_modules', 'photoswipe', 'dist');
// Browser libraries served from node_modules (no CDN): fixed public name → file.
const VENDOR_FILES = {
  'photoswipe.esm.min.js': path.join(PHOTOSWIPE_DIST, 'photoswipe.esm.min.js'),
  'photoswipe-lightbox.esm.min.js': path.join(PHOTOSWIPE_DIST, 'photoswipe-lightbox.esm.min.js'),
  'photoswipe.css': path.join(PHOTOSWIPE_DIST, 'photoswipe.css'),
};

// Custom header required on every state-changing request. Cross-site forms cannot set it,
// and a cross-origin fetch that sets it needs a CORS preflight we never answer.
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'guest-gateway';

const TUS_ROUTE = /^\/files(?:\/[A-Za-z0-9_-]+)?\/?$/;
const TUS_METHODS = new Set(['POST', 'PATCH', 'HEAD']);
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Per status request; the client polls in batches of this size.
export const MAX_STATUS_IDS = 100;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// A login body is tiny; a client that has not sent it by then is stalling on purpose.
const LOGIN_BODY_TIMEOUT_MS = 10_000;

const CLOSED_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>受付終了</title></head>
<body><p>このアップロード窓口は受付を終了しました。ありがとうございました。</p></body></html>`;

function cookieName(config) {
  // __Host- requires Secure, so local http development uses a plain name.
  return config.cookieSecure ? '__Host-gw' : 'gw';
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {{
 *   store?: ReturnType<import('./store.js').openStore>,
 *   importer?: ReturnType<import('./importer.js').createImporter>,
 *   immich?: ReturnType<import('./immich.js').createImmichClient>,
 * }} [deps] store + importer = import mode; neither = speed-test mode (files are not imported).
 *   immich (with store) enables the gallery.
 */
export function createApp(config, { store, importer, immich } = {}) {
  const app = express();
  const importing = Boolean(store && importer);
  const tusServer = createTusServer(
    config,
    importing
      ? {
          onReceived(file) {
            store.add(file);
            importer.enqueue(file.uploadId);
          },
        }
      : {},
  );
  const lockout = createLockout();
  const isClosed = () => Date.now() >= config.closesAt;
  // Fingerprint of the organiser password hash, stored in admin sessions.
  const adminTag = config.adminPasswordHash ? shortHash(config.adminPasswordHash) : null;

  app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'data:', 'blob:'],
          'media-src': ["'self'", 'blob:'],
          'connect-src': ["'self'"],
          'upgrade-insecure-requests': config.cookieSecure ? [] : null,
        },
      },
      strictTransportSecurity: config.cookieSecure,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      log('info', 'http', {
        method: req.method,
        path: TUS_ROUTE.test(req.path) ? '/files' : req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        device: req.gwSession?.deviceShort,
      });
    });
    next();
  });

  app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
  app.get('/robots.txt', (_req, res) =>
    res.type('text/plain').send('User-agent: *\nDisallow: /\n'),
  );

  // Deadline: everything below is closed once CLOSES_AT has passed.
  app.use((req, res, next) => {
    if (!isClosed()) return next();
    if (req.path.startsWith('/api/') || TUS_ROUTE.test(req.path)) {
      return res.status(410).json({ error: 'closed' });
    }
    return res.status(410).type('html').send(CLOSED_HTML);
  });

  // Session from the signed cookie (if any).
  app.use((req, _res, next) => {
    const session = verifySession(readCookie(req, cookieName(config)), config.sessionSecret);
    // Admin sessions are bound to the current organiser password: clearing or changing
    // ADMIN_PASSWORD_HASH (and restarting) demotes existing admin cookies to guests.
    if (session?.role === 'admin' && session.adminTag !== adminTag) session.role = 'guest';
    if (session) req.gwSession = { ...session, deviceShort: shortHash(session.deviceId) };
    next();
  });

  // CSRF guard for state-changing requests.
  app.use((req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) return next();
    if (req.get('sec-fetch-site') === 'cross-site' || req.get(CSRF_HEADER) !== CSRF_VALUE) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return next();
  });

  const requireSession = (req, res, next) => {
    if (!req.gwSession) return res.status(401).json({ error: 'unauthorized' });
    return next();
  };

  // Coarse outer cap on failed/rejected login requests per IP. Successful logins are not
  // counted, so many guests behind one venue NAT can all sign in; the real brute-force
  // control is `lockout`.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      log('warn', 'login_rate_limited', { ip: req.ip });
      res.status(429).json({ error: 'too_many_attempts' });
    },
  });

  app.get('/api/session', (req, res) => {
    res.json({
      authenticated: Boolean(req.gwSession),
      nickname: req.gwSession?.nickname ?? null,
      role: req.gwSession?.role ?? null,
      canDelete: Boolean(immich && store && config.immich?.deleteApiKey),
      importing,
      gallery: Boolean(immich && store),
      closesAt: new Date(config.closesAt),
    });
  });

  const parseLoginBody = express.json({ limit: '1kb' });
  const loginBodyTimeoutMs = config.loginBodyTimeoutMs ?? LOGIN_BODY_TIMEOUT_MS;
  // Resolves true once the body is parsed, false if the deadline passes first; parser errors
  // reject. The parser may still call back after the deadline (when the socket is torn down),
  // so `settled` turns that late call into a no-op instead of a second outcome.
  const parseBody = (req, res) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve(false);
      }, loginBodyTimeoutMs);
      parseLoginBody(req, res, (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(true);
      });
    });

  app.post('/api/login', loginLimiter, async (req, res) => {
    // Cheap status check (reserves nothing): locked or paused clients are turned away before
    // they can send a body.
    const status = lockout.check(req.ip);
    if (!status.allowed) {
      res.set('Retry-After', String(Math.ceil(status.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'too_many_attempts' });
    }
    // No attempt slot is held while the body arrives, so stalled bodies cannot starve the
    // limited slots; the deadline frees the parser and the connection.
    // Body-parser errors propagate to the error handler (Express 5 forwards rejections).
    if (!(await parseBody(req, res))) {
      log('warn', 'login_body_timeout', { ip: req.ip });
      if (res.headersSent) return req.destroy();
      res.set('Connection', 'close');
      res.once('finish', () => req.destroy());
      return res.status(408).json({ error: 'timeout' });
    }
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const nickname = normalizeNickname(req.body?.nickname);
    if (!nickname) return res.status(400).json({ error: 'bad_nickname' });
    // Reserve the attempt synchronously and start scrypt with no await in between: the lock
    // check and the in-flight mark happen atomically, so parallel requests cannot all slip past
    // the lockout while scrypt runs, and a slot is only ever held for one password check.
    const attempt = lockout.beginAttempt(req.ip);
    if (!attempt.ok) {
      res.set('Retry-After', String(attempt.retryAfterSec));
      const error = attempt.reason === 'busy' ? 'busy' : 'too_many_attempts';
      return res.status(429).json({ error });
    }
    try {
      // Guest first: if both passwords were ever set to the same value, nobody becomes admin.
      let role = null;
      if (await verifyPassword(password, config.guestPasswordHash)) role = 'guest';
      else if (
        config.adminPasswordHash &&
        (await verifyPassword(password, config.adminPasswordHash))
      ) {
        role = 'admin';
      }
      if (!role) {
        log('warn', 'login_failed', { ip: req.ip });
        lockout.recordFailure(req.ip);
        return res.status(401).json({ error: 'wrong_password' });
      }
      lockout.recordSuccess(req.ip);
      const session = { deviceId: newDeviceId(), nickname, role, exp: config.closesAt };
      if (role === 'admin') session.adminTag = adminTag;
      res.cookie(cookieName(config), signSession(session, config.sessionSecret), {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: Math.max(0, config.closesAt - Date.now()),
      });
      log('info', 'login_ok', { device: shortHash(session.deviceId), role });
      return res.json({ ok: true, role });
    } finally {
      attempt.release();
    }
  });

  // Speed-test diagnostics: which client address the app sees behind Funnel.
  app.get('/api/whoami', requireSession, (req, res) => {
    res.json({ ip: req.ip, viaFunnel: Boolean(req.get('tailscale-funnel-request')) });
  });

  // Import status of the caller's own uploads (the client polls this after each upload).
  // `?ids=a,b,c` asks for the uploads the client is still waiting on (any age); without it the
  // newest uploads are listed.
  app.get('/api/uploads', requireSession, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!importing) return res.json({ uploads: [] });
    const { deviceId } = req.gwSession;
    if (req.query.ids === undefined) return res.json({ uploads: store.listForDevice(deviceId) });
    const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
    if (ids.length === 0 || ids.length > MAX_STATUS_IDS || !ids.every((id) => UPLOAD_ID.test(id))) {
      return res.status(400).json({ error: 'bad_request' });
    }
    return res.json({ uploads: store.statusForDevice(deviceId, ids) });
  });

  if (immich && store) {
    const gallery = createGalleryRouter({
      immich,
      store,
      albumId: config.immich.albumId,
      closesAt: config.closesAt,
      deleteEnabled: Boolean(config.immich.deleteApiKey),
      heavyIdleMs: config.mediaIdleMs,
    });
    app.use(['/api/assets', '/media'], requireSession);
    app.use(gallery);
  }

  app.all(TUS_ROUTE, requireSession, (req, res, next) => {
    // GET would let tus serve staged files back; OPTIONS/DELETE are not needed.
    if (!TUS_METHODS.has(req.method)) return next();
    return tusServer.handle(req, res);
  });

  app.get('/vendor/tus.min.js', (_req, res) => res.sendFile(TUS_CLIENT_PATH));
  app.get('/vendor/photoswipe/:file', (req, res, next) => {
    if (!Object.hasOwn(VENDOR_FILES, req.params.file)) return next();
    return res.sendFile(VENDOR_FILES[req.params.file]);
  });
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // Express needs the 4-arg signature to treat this as the error handler.
  app.use((err, req, res, _next) => {
    // body-parser errors (malformed JSON, too large) carry a 4xx status.
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log('error', 'unhandled', { path: req.path, error: err.message });
    if (!res.headersSent)
      res.status(status).json({ error: status === 500 ? 'internal' : 'bad_request' });
  });

  return { app, tusServer, isClosed };
}
