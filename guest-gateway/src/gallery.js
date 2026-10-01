// guest-gateway/src/gallery.js
// ギャラリー用の読み取り中継: アルバム一覧(必要な項目だけに絞る)と、サムネイル・プレビュー・動画・
// オリジナルのストリーミング中継。Immich のエラー本文・内部パス・余計なヘッダーはゲストに渡さない。
// 一覧は全件をまとめて返す: Immich のページ送りは件数オフセット方式で、撮影日時(秒単位)が同じ写真の
// 並びが安定しないため、ページの境目で重複・欠落が起きる。窓口で集約・重複除去・安定ソートし、
// 短時間キャッシュしてゲスト全員で共有する。

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { ImmichError, isUuid, MEDIA_KINDS } from './immich.js';
import { log } from './log.js';

// Immich's maximum page size; fewer pages = fewer unstable page boundaries.
const PAGE_SIZE = 1000;
// Safety cap (50,000 assets) against a cursor loop.
const MAX_PAGES = 50;
const LIST_CACHE_MS = 10_000;
// Response headers relayed from Immich; everything else (cookies, server info...) is dropped.
const RELAY_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag'];
// Immich sends `inline; filename*=UTF-8''<percent-encoded name>`; only that exact shape is reused.
const IMMICH_DISPOSITION = /^inline; filename\*=UTF-8''([A-Za-z0-9%._~!'()*-]{1,512})$/;
// Asset bytes never change for an id, so browsers may keep them for the event.
const MEDIA_CACHE = 'private, max-age=86400';

/** The only asset fields a guest needs (Immich also returns owner ids, internal paths, ...). */
function toGuestAsset(asset, uploader) {
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
    mine: uploader?.mine ?? false,
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
 *   now?: () => number,
 * }} deps
 */
export function createGalleryRouter({ immich, store, albumId, now = Date.now }) {
  const router = express.Router();
  // { at, promise } of the last successful (or in-flight) full listing, shared by all guests.
  let cache = null;

  async function fetchAlbum() {
    const byId = new Map();
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await immich.listAlbumAssets({ albumId, cursor, size: PAGE_SIZE });
      for (const asset of result.items) {
        if (isUuid(asset?.id)) byId.set(asset.id, asset);
      }
      cursor = result.nextCursor;
      if (!cursor) return [...byId.values()].sort(compareAssets);
    }
    log('warn', 'gallery_page_cap_reached', { pages: MAX_PAGES });
    return [...byId.values()].sort(compareAssets);
  }

  function loadAlbum() {
    if (cache && now() - cache.at < LIST_CACHE_MS) return cache.promise;
    const entry = { at: now(), promise: fetchAlbum() };
    // Failures are not cached: the next request tries again.
    entry.promise.catch(() => {
      if (cache === entry) cache = null;
    });
    cache = entry;
    return entry.promise;
  }

  router.get('/api/assets', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let assets;
    try {
      assets = await loadAlbum();
    } catch (err) {
      log('error', 'gallery_list_failed', { error: err.message });
      return res.status(502).json({ error: 'unavailable' });
    }
    const uploaders = store.uploaders(
      assets.map((a) => a.id),
      req.gwSession.deviceId,
    );
    return res.json({ assets: assets.map((a) => toGuestAsset(a, uploaders.get(a.id))) });
  });

  router.get('/media/:id/:kind', async (req, res, next) => {
    const { id, kind } = req.params;
    // Unknown shapes fall through to the app's 404.
    if (!isUuid(id) || !MEDIA_KINDS.includes(kind)) return next();

    // Stop the upstream transfer as soon as the guest goes away.
    const controller = new AbortController();
    res.once('close', () => controller.abort());

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
      const status = err instanceof ImmichError ? err.status : 0;
      if (status === 416) return res.status(416).end();
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
    res.set('Cache-Control', MEDIA_CACHE);
    if (kind === 'original' && req.query.download === '1') {
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
    try {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (err) {
      // Client disconnects abort the pipeline; only report real upstream failures.
      if (!controller.signal.aborted) {
        log('warn', 'media_stream_interrupted', { kind, error: err.message });
      }
    }
    return undefined;
  });

  return router;
}
