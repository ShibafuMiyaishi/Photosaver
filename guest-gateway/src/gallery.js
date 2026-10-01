// guest-gateway/src/gallery.js
// ギャラリー用の読み取り中継: アルバム一覧(必要な項目だけに絞る)と、サムネイル・プレビュー・動画・
// オリジナルのストリーミング中継。Immich のエラー本文・内部パス・余計なヘッダーはゲストに渡さない。
// 一覧は全件をまとめて返す: Immich のページ送りは件数オフセット方式で、撮影日時(秒単位)が同じ写真の
// 並びが問い合わせごとに変わるため、ページの境目で重複・欠落が起きる。窓口で全ページを集約して重複を
// 除き、アルバムの件数に届かなければ並び順を変えて取り直して補い、安定ソートして短時間キャッシュする。
// PC 向けの ZIP 一括ダウンロード: Immich に約 2 GB ごとの分割を計画させて窓口が保持し、各 ZIP は
// ダウンロードの時点でアルバムにある写真だけに絞って Immich の ZIP 生成を中継する。

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import express from 'express';
import { isUuid, MEDIA_KINDS } from './immich.js';
import { log } from './log.js';

const gzip = promisify(zlib.gzip);

// Immich's maximum page size; fewer pages = fewer unstable page boundaries.
const PAGE_SIZE = 1000;
// Safety cap (50,000 assets) against a cursor loop.
const MAX_PAGES = 50;
// Full listings per refresh when tied capture times make pages skip assets (only possible
// above PAGE_SIZE assets). Alternating the direction reshuffles the page boundaries.
const LIST_PASSES = ['desc', 'asc', 'desc', 'asc'];
const LIST_CACHE_MS = 10_000;
// Response headers relayed from Immich; everything else (cookies, server info...) is dropped.
const RELAY_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag'];
// Immich sends `inline; filename*=UTF-8''<percent-encoded name>`; only that exact shape is reused.
const IMMICH_DISPOSITION = /^inline; filename\*=UTF-8''([A-Za-z0-9%._~!'()*-]{1,512})$/;
// Rendered inline only for these; anything else (SVG from the Immich app, unknown types) is
// downloaded as an opaque file so it can never run as a document on the gateway origin.
const INLINE_TYPE = /^(?:image\/(?!svg)[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;
// Asset bytes never change for an id; browsers may keep them, but never past the deadline.
const MEDIA_MAX_AGE_S = 86_400;
// Parallel media responses (429 + Retry-After beyond these). Thumbnails/previews are small and
// a grid over HTTP/2 asks for many at once; originals/videos hold an Immich connection and HDD
// reads for long, so they get a small per-device share of a global pool.
const LIGHT_PER_DEVICE = 48;
const HEAVY_PER_DEVICE = 4;
const HEAVY_STREAMS_TOTAL = 32;
// A heavy stream that moves no bytes for this long (paused <video>, stalled or idle reader) is
// closed so it cannot hold a slot forever; players re-request with Range when resumed.
const HEAVY_IDLE_MS = 60_000;
// ZIP parts: a ZIP is built on the fly and cannot be resumed, so parts stay moderate.
const ZIP_PART_BYTES = 2 * 1024 ** 3;
// A ZIP reads originals from the HDD for minutes; keep them few (beyond → busy page).
const ZIP_PER_DEVICE = 2;
const ZIP_STREAMS_TOTAL = 4;
// One plan per device (a new one replaces it); old plans expire.
const ZIP_PLAN_TTL_MS = 24 * 60 * 60_000;
const MAX_ZIP_PLANS = 500;
const PLAN_ID = /^[0-9a-f]{32}$/;
const PART_NUMBER = /^[1-9][0-9]{0,3}$/;

/** Minimal page for ZIP links: they are opened by navigation, so errors must be readable. */
function sendPage(res, status, message) {
  const escaped = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<meta name="robots" content="noindex"><title>ダウンロード</title></head>` +
        `<body><p>${escaped}</p><p><a href="/">写真の一覧に戻る</a></p></body></html>`,
    );
}

/** The only asset fields a guest needs (Immich also returns owner ids, internal paths, ...). */
function toGuestAsset(asset, uploader, deviceId) {
  return {
    id: asset.id,
    type: asset.type === 'VIDEO' ? 'video' : 'image',
    width: Number.isFinite(asset.width) ? asset.width : null,
    height: Number.isFinite(asset.height) ? asset.height : null,
    takenAt: asset.fileCreatedAt ?? null,
    durationMs: Number.isFinite(asset.duration) ? asset.duration : null,
    thumbhash: typeof asset.thumbhash === 'string' ? asset.thumbhash : null,
    filename: typeof asset.originalFileName === 'string' ? asset.originalFileName : null,
    by: uploader?.nickname ?? null,
    mine: Boolean(uploader) && uploader.deviceId === deviceId,
  };
}

/** Newest first by capture time; the id breaks ties so the order is stable between requests. */
function compareAssets(a, b) {
  const ta = Date.parse(a.fileCreatedAt ?? '') || 0;
  const tb = Date.parse(b.fileCreatedAt ?? '') || 0;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * @param {{
 *   immich: ReturnType<import('./immich.js').createImmichClient>,
 *   store: ReturnType<import('./store.js').openStore>,
 *   albumId: string,
 *   closesAt: number,
 *   deleteEnabled?: boolean,
 *   now?: () => number,
 *   heavyIdleMs?: number,
 * }} deps
 */
export function createGalleryRouter({
  immich,
  store,
  albumId,
  closesAt,
  deleteEnabled = false,
  now = Date.now,
  heavyIdleMs = HEAVY_IDLE_MS,
}) {
  const router = express.Router();
  // { at, promise } of the last full listing, shared by all guests. `at` is set when the
  // listing completes, so a slow listing stays single-flight until it is done.
  let cache = null;
  // deviceId → { light, heavy } responses in flight.
  const mediaInFlight = new Map();
  let heavyInFlight = 0;
  // planId → { deviceId, createdAt, parts: string[][] }; Map order = creation order.
  const zipPlans = new Map();
  // deviceId → ZIP streams in flight.
  const zipInFlight = new Map();
  let zipStreams = 0;

  async function listPass(byId, direction) {
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await immich.listAlbumAssets({ albumId, cursor, size: PAGE_SIZE, direction });
      for (const asset of result.items) {
        if (isUuid(asset?.id)) byId.set(asset.id, asset);
      }
      cursor = result.nextCursor;
      if (!cursor) return;
    }
    log('warn', 'gallery_page_cap_reached', { pages: MAX_PAGES });
  }

  async function fetchAlbum() {
    // Taken first: uploads during the listing only make the listing larger, never short.
    const expected = (await immich.getAlbum(albumId)).assetCount;
    const byId = new Map();
    for (const direction of LIST_PASSES) {
      await listPass(byId, direction);
      if (!Number.isFinite(expected) || byId.size >= expected) break;
    }
    if (Number.isFinite(expected) && byId.size < expected) {
      log('warn', 'gallery_listing_incomplete', { expected, listed: byId.size });
    }
    const assets = [...byId.values()].sort(compareAssets);
    // Uploader lookup is shared too; only `mine` is computed per guest.
    const uploaders = store.uploaders(assets.map((a) => a.id));
    return { assets, uploaders };
  }

  function loadAlbum() {
    if (cache && (cache.at === null || now() - cache.at < LIST_CACHE_MS)) return cache.promise;
    const entry = { at: null, promise: fetchAlbum() };
    entry.promise.then(
      () => {
        entry.at = now();
      },
      // Failures are not cached: the next request tries again.
      () => {
        if (cache === entry) cache = null;
      },
    );
    cache = entry;
    return entry.promise;
  }

  router.get('/api/assets', async (req, res) => {
    // Revalidate every time (ETag → 304 when nothing changed), never store on shared caches.
    res.set('Cache-Control', 'private, no-cache');
    res.vary('Accept-Encoding');
    let album;
    try {
      album = await loadAlbum();
    } catch (err) {
      log('error', 'gallery_list_failed', { error: err.message });
      return res.status(502).json({ error: 'unavailable' });
    }
    const { deviceId } = req.gwSession;
    const body = JSON.stringify({
      assets: album.assets.map((a) => toGuestAsset(a, album.uploaders.get(a.id), deviceId)),
    });
    res.type('json');
    // Thousands of entries with repeated keys: compress (no compression middleware is used).
    if (req.acceptsEncodings('gzip') === 'gzip') {
      res.set('Content-Encoding', 'gzip');
      return res.send(await gzip(body));
    }
    return res.send(body);
  });

  // Guests delete what their own device uploaded; the organiser (admin) deletes anything.
  // Never `force`: assets go to the event user's trash and can be restored in Immich.
  router.delete('/api/assets/:id', async (req, res, next) => {
    const { id } = req.params;
    if (!isUuid(id) || !deleteEnabled) return next();
    const { deviceId, role } = req.gwSession;
    if (role === 'admin') {
      // Even the organiser deletes only what is in the event album right now: the delete key
      // could also trash anything else the event user owns.
      let album;
      try {
        album = await loadAlbum();
      } catch (err) {
        log('error', 'gallery_list_failed', { error: err.message });
        return res.status(502).json({ error: 'unavailable' });
      }
      if (!album.assets.some((a) => a.id === id))
        return res.status(404).json({ error: 'not_found' });
    } else if (!store.isOwnAsset(id, deviceId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      await immich.deleteAssets([id]);
    } catch (err) {
      const status = err.status ?? 0;
      // Gone already. Anything else (401/403: wrong or under-permissioned delete key) is a setup
      // problem the organiser must see in the logs, never a silent "deleted".
      if (status === 400 || status === 404) return res.status(404).json({ error: 'not_found' });
      log('error', 'asset_delete_failed', { status, error: err.message });
      return res.status(502).json({ error: 'unavailable' });
    }
    store.markDeleted(id);
    // The next listing must not show it any more.
    cache = null;
    log('info', 'asset_deleted', {
      asset: id.slice(0, 8),
      role,
      device: req.gwSession.deviceShort,
    });
    return res.json({ ok: true });
  });

  router.get('/media/:id/:kind', async (req, res, next) => {
    const { id, kind } = req.params;
    // Unknown shapes fall through to the app's 404.
    if (!isUuid(id) || !MEDIA_KINDS.includes(kind)) return next();

    const { deviceId } = req.gwSession;
    const slot = kind === 'original' || kind === 'video' ? 'heavy' : 'light';
    const counts = mediaInFlight.get(deviceId) ?? { light: 0, heavy: 0 };
    const full =
      slot === 'light'
        ? counts.light >= LIGHT_PER_DEVICE
        : counts.heavy >= HEAVY_PER_DEVICE || heavyInFlight >= HEAVY_STREAMS_TOTAL;
    if (full) {
      res.set('Retry-After', '2');
      return res.status(429).json({ error: 'busy' });
    }
    counts[slot] += 1;
    mediaInFlight.set(deviceId, counts);
    if (slot === 'heavy') heavyInFlight += 1;

    // Stop the upstream transfer as soon as the guest goes away; release the slots once.
    const controller = new AbortController();
    res.once('close', () => {
      controller.abort();
      counts[slot] -= 1;
      if (counts.light === 0 && counts.heavy === 0) mediaInFlight.delete(deviceId);
      if (slot === 'heavy') heavyInFlight -= 1;
    });

    let upstream;
    try {
      upstream = await immich.fetchMedia({
        kind,
        id,
        range: req.get('range'),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return undefined;
      const status = err.status ?? 0;
      // Not in the album / not ready: indistinguishable from a missing asset for the guest.
      if (status >= 400 && status < 500) return res.status(404).json({ error: 'not_found' });
      log('error', 'media_relay_failed', { kind, status, error: err.message });
      return res.status(502).json({ error: 'unavailable' });
    }

    res.status(upstream.status);
    for (const name of RELAY_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.set(name, value);
    }
    if (upstream.status === 416) {
      // Keep Content-Range (bytes */size) so players can recover; no body.
      await upstream.body?.cancel().catch(() => {});
      return res.end();
    }
    const maxAge = Math.max(0, Math.min(MEDIA_MAX_AGE_S, Math.floor((closesAt - now()) / 1000)));
    res.set('Cache-Control', `private, max-age=${maxAge}`);
    const inline = INLINE_TYPE.test(upstream.headers.get('content-type') ?? '');
    if (!inline) res.set('Content-Type', 'application/octet-stream');
    if (!inline || (kind === 'original' && req.query.download === '1')) {
      const match = IMMICH_DISPOSITION.exec(upstream.headers.get('content-disposition') ?? '');
      res.set(
        'Content-Disposition',
        match ? `attachment; filename*=UTF-8''${match[1]}` : 'attachment',
      );
    }
    if (!upstream.body || req.method === 'HEAD') {
      await upstream.body?.cancel().catch(() => {});
      return res.end();
    }
    const body = Readable.fromWeb(upstream.body);
    // Registered before pipeline() so it runs before the response is torn down: tells real
    // upstream failures apart from guests closing the connection.
    let upstreamFailed = false;
    body.once('error', () => {
      upstreamFailed = !controller.signal.aborted;
    });
    const piping = pipeline(body, res);
    if (slot === 'heavy') {
      // Reset on every chunk that moves; under backpressure no chunks flow, so a reader that
      // stopped reading is closed after heavyIdleMs. Attached after pipeline() so no chunk can
      // flow before the response is wired up.
      const idle = setTimeout(() => res.destroy(), heavyIdleMs);
      idle.unref();
      body.on('data', () => idle.refresh());
      res.once('close', () => clearTimeout(idle));
    }
    try {
      await piping;
    } catch (err) {
      if (upstreamFailed) log('warn', 'media_stream_interrupted', { kind, error: err.message });
    }
    return undefined;
  });

  function dropExpiredPlans() {
    for (const [id, plan] of zipPlans) {
      if (now() - plan.createdAt < ZIP_PLAN_TTL_MS && zipPlans.size <= MAX_ZIP_PLANS) break;
      zipPlans.delete(id);
    }
  }

  // Plan the ZIP parts for this guest (PCs; phones save into the photo app instead).
  router.post('/api/download', async (req, res) => {
    const { deviceId } = req.gwSession;
    let info;
    try {
      info = await immich.downloadInfo({ albumId, archiveSize: ZIP_PART_BYTES });
    } catch (err) {
      log('error', 'zip_plan_failed', { status: err.status ?? 0, error: err.message });
      return res.status(502).json({ error: 'unavailable' });
    }
    for (const [id, plan] of zipPlans) if (plan.deviceId === deviceId) zipPlans.delete(id);
    const id = crypto.randomBytes(16).toString('hex');
    zipPlans.set(id, {
      deviceId,
      createdAt: now(),
      parts: info.archives.map((archive) => archive.assetIds),
    });
    dropExpiredPlans();
    log('info', 'zip_planned', {
      device: req.gwSession.deviceShort,
      parts: info.archives.length,
      bytes: info.totalSize,
    });
    return res.json({
      id,
      totalSize: info.totalSize,
      parts: info.archives.map((archive) => ({
        size: archive.size,
        count: archive.assetIds.length,
      })),
    });
  });

  router.get('/download/:plan/:part', async (req, res, next) => {
    const { plan: planId, part } = req.params;
    if (!PLAN_ID.test(planId) || !PART_NUMBER.test(part)) return next();
    const session = req.gwSession;
    if (!session)
      return sendPage(
        res,
        401,
        'ログインの有効期限が切れました。一覧に戻ってログインし直してください。',
      );
    const plan = zipPlans.get(planId);
    const index = Number(part) - 1;
    if (
      !plan ||
      plan.deviceId !== session.deviceId ||
      now() - plan.createdAt >= ZIP_PLAN_TTL_MS ||
      index >= plan.parts.length
    ) {
      return sendPage(
        res,
        404,
        'このダウンロードの期限が切れました。一覧に戻って、もう一度「ZIP を作成」してください。',
      );
    }
    const total = plan.parts.length;
    const filename = total === 1 ? 'photos.zip' : `photos-${index + 1}-of-${total}.zip`;
    // A HEAD (link checkers, some download managers) must not make Immich build a whole ZIP.
    if (req.method === 'HEAD') {
      res.set({ 'Content-Type': 'application/zip', 'Cache-Control': 'private, no-store' });
      return res.end();
    }
    const { deviceId } = session;
    const mine = zipInFlight.get(deviceId) ?? 0;
    if (mine >= ZIP_PER_DEVICE || zipStreams >= ZIP_STREAMS_TOTAL) {
      return sendPage(
        res,
        429,
        'ダウンロードが混み合っています。今のダウンロードが終わってから、もう一度お試しください。',
      );
    }

    // Only what is in the album right now: one trashed id makes Immich reject the whole ZIP.
    let album;
    try {
      album = await loadAlbum();
    } catch (err) {
      log('error', 'gallery_list_failed', { error: err.message });
      return sendPage(
        res,
        502,
        '写真を準備できませんでした。しばらくしてから、もう一度お試しください。',
      );
    }
    const present = new Set();
    for (const asset of album.assets) {
      present.add(asset.id);
      if (isUuid(asset.livePhotoVideoId)) present.add(asset.livePhotoVideoId);
    }
    const assetIds = plan.parts[index].filter((id) => present.has(id));
    if (assetIds.length === 0) {
      return sendPage(res, 404, 'この ZIP の写真はすべて削除されています。');
    }

    zipInFlight.set(deviceId, mine + 1);
    zipStreams += 1;
    const controller = new AbortController();
    res.once('close', () => {
      controller.abort();
      const left = (zipInFlight.get(deviceId) ?? 1) - 1;
      if (left > 0) zipInFlight.set(deviceId, left);
      else zipInFlight.delete(deviceId);
      zipStreams -= 1;
    });

    let upstream;
    try {
      upstream = await immich.downloadArchive({ assetIds, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) return undefined;
      log('error', 'zip_relay_failed', { status: err.status ?? 0, error: err.message });
      return sendPage(
        res,
        502,
        'ZIP を作成できませんでした。一覧に戻って、もう一度「ZIP を作成」してください。',
      );
    }
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    });
    if (!upstream.body) {
      res.end();
      return undefined;
    }
    log('info', 'zip_started', {
      device: session.deviceShort,
      part: index + 1,
      assets: assetIds.length,
    });
    const body = Readable.fromWeb(upstream.body);
    let upstreamFailed = false;
    body.once('error', () => {
      upstreamFailed = !controller.signal.aborted;
    });
    const piping = pipeline(body, res);
    // Same idle rule as other heavy streams: a reader that stopped reading frees its slot.
    const idle = setTimeout(() => res.destroy(), heavyIdleMs);
    idle.unref();
    body.on('data', () => idle.refresh());
    res.once('close', () => clearTimeout(idle));
    try {
      await piping;
    } catch (err) {
      if (upstreamFailed) log('warn', 'zip_stream_interrupted', { error: err.message });
    }
    return undefined;
  });

  return router;
}
