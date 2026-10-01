// guest-gateway/src/immich.js
// Immich v3 API の呼び出し。共有リンクキー(1 アルバム限定)と削除専用 API キーだけを使い、
// Immich のエラー本文や内部 URL は呼び出し元に渡さない。ファイルはメモリに全読み込みしない。

import { openAsBlob } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_STATUSES = new Set(['created', 'duplicate']);

// Media the gateway may relay, mapped to Immich paths (never built from client input).
const MEDIA_PATHS = {
  thumbnail: (id) => `assets/${id}/thumbnail?size=thumbnail`,
  preview: (id) => `assets/${id}/thumbnail?size=preview`,
  video: (id) => `assets/${id}/video/playback`,
  original: (id) => `assets/${id}/original`,
};
export const MEDIA_KINDS = Object.keys(MEDIA_PATHS);
// Only a single, simple byte range ("a-", "a-b" or the suffix "-n") is forwarded.
const RANGE = /^bytes=(?:\d{1,15}-\d{0,15}|-\d{1,15})$/;
// Statuses relayed to the guest; 416 keeps Content-Range so players can recover.
const MEDIA_STATUSES = new Set([200, 206, 416]);
const ARCHIVE_STATUSES = new Set([200]);

export class ImmichError extends Error {
  /**
   * @param {string} op short operation name (safe to log)
   * @param {number} status HTTP status from Immich, or 0 for network/timeout errors
   */
  constructor(op, status) {
    super(`immich ${op} failed (${status || 'network'})`);
    this.name = 'ImmichError';
    this.op = op;
    this.status = status;
  }
}

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function toIso(ms) {
  // null, '', 0, NaN and negatives would turn into 1970 or an invalid date: treat them as missing.
  const n = Number(ms);
  const date = new Date(Number.isFinite(n) && n > 0 ? n : NaN);
  // Out-of-range values (> year 275760) are also invalid dates.
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/**
 * @param {{
 *   baseUrl: string,
 *   shareKey?: string,
 *   deleteApiKey?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   uploadTimeoutMs?: number,
 * }} options
 */
export function createImmichClient({
  baseUrl,
  shareKey,
  deleteApiKey,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  uploadTimeoutMs = 30 * 60_000,
}) {
  const root = new URL('/api/', baseUrl);

  async function request(
    op,
    path,
    { method = 'GET', auth, json, body, signal, timeout = timeoutMs },
  ) {
    const headers = {};
    if (auth === 'share') {
      if (!shareKey) throw new ImmichError(op, 0);
      // Header, never ?key=: query strings end up in access logs.
      headers['x-immich-share-key'] = shareKey;
    } else if (auth === 'delete') {
      if (!deleteApiKey) throw new ImmichError(op, 0);
      headers['x-api-key'] = deleteApiKey;
    }
    if (json !== undefined) headers['content-type'] = 'application/json';

    const signals = [signal, AbortSignal.timeout(timeout)].filter(Boolean);
    let res;
    try {
      res = await fetchImpl(new URL(path, root), {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: AbortSignal.any(signals),
        redirect: 'error',
      });
    } catch {
      throw new ImmichError(op, 0);
    }
    if (!res.ok) {
      // Drain without reading: Immich error bodies may contain internal details.
      await res.body?.cancel().catch(() => {});
      throw new ImmichError(op, res.status);
    }
    return res;
  }

  async function readJson(op, res) {
    try {
      return await res.json();
    } catch {
      throw new ImmichError(op, res.status);
    }
  }

  /**
   * Open a long-running download through the share link. Only the wait for response headers is
   * time-limited; the body may stream for as long as the guest keeps reading (abort via `signal`).
   * Resolves with the upstream Response when its status is in `statuses`.
   */
  async function openStream(op, path, { method = 'GET', headers = {}, json, signal, statuses }) {
    if (!shareKey || signal?.aborted) throw new ImmichError(op, 0);
    const allHeaders = {
      ...headers,
      'x-immich-share-key': shareKey,
      // Photos and videos do not compress: never let Immich spend CPU gzipping them.
      'accept-encoding': 'identity',
    };
    if (json !== undefined) allHeaders['content-type'] = 'application/json';
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const headerTimer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(new URL(path, root), {
        method,
        headers: allHeaders,
        body: json !== undefined ? JSON.stringify(json) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      signal?.removeEventListener('abort', onAbort);
      throw new ImmichError(op, 0);
    } finally {
      clearTimeout(headerTimer);
    }
    if (!statuses.has(res.status)) {
      signal?.removeEventListener('abort', onAbort);
      await res.body?.cancel().catch(() => {});
      throw new ImmichError(op, res.status);
    }
    return res;
  }

  return {
    async serverVersion() {
      const res = await request('version', 'server/version', {});
      const { major, minor, patch } = await readJson('version', res);
      return { major, minor, patch };
    },

    /**
     * Upload one file through the album shared link; Immich adds it to the album itself.
     * @param {{ filePath: string, filename: string, mime: string, lastModified?: number|string,
     *   signal?: AbortSignal }} file
     */
    async uploadAsset({ filePath, filename, mime, lastModified, signal }) {
      let blob;
      try {
        blob = await openAsBlob(filePath, { type: mime || 'application/octet-stream' });
      } catch {
        // fs errors carry the staging path; never let it reach callers or logs.
        throw new ImmichError('upload', 0);
      }
      const form = new FormData();
      const when = toIso(lastModified);
      // Do NOT send x-immich-checksum: that path short-circuits before the album add.
      form.append('assetData', blob, filename);
      form.append('fileCreatedAt', when);
      form.append('fileModifiedAt', when);
      form.append('filename', filename);
      // Large videos over a local link: no short per-request timeout, only an overall cap
      // (uploadTimeoutMs) combined with the caller's optional signal.
      const res = await request('upload', 'assets', {
        method: 'POST',
        auth: 'share',
        body: form,
        signal,
        timeout: uploadTimeoutMs,
      });
      const data = await readJson('upload', res);
      if (!UPLOAD_STATUSES.has(data?.status) || !isUuid(data?.id)) {
        throw new ImmichError('upload', res.status);
      }
      return { status: data.status, id: data.id };
    },

    /**
     * Whether an asset is currently readable through the share link: true for album assets,
     * false (Immich answers 400) for assets in the trash. Verified on v3.2.4.
     */
    async isAssetVisible(id) {
      if (!isUuid(id)) throw new ImmichError('asset', 0);
      try {
        const res = await request('asset', `assets/${id}`, { auth: 'share' });
        await res.body?.cancel().catch(() => {});
        return true;
      } catch (err) {
        if (err instanceof ImmichError && (err.status === 400 || err.status === 404)) return false;
        throw err;
      }
    },

    async getAlbum(albumId) {
      if (!isUuid(albumId)) throw new ImmichError('album', 0);
      const res = await request('album', `albums/${albumId}`, { auth: 'share' });
      const data = await readJson('album', res);
      return { id: data.id, albumName: data.albumName, assetCount: data.assetCount };
    },

    /**
     * One page of the album's assets, newest first.
     * @param {{ albumId: string, cursor?: string|null, size?: number,
     *   direction?: 'desc'|'asc' }} query
     */
    async listAlbumAssets({ albumId, cursor = null, size = 200, direction = 'desc' }) {
      if (!isUuid(albumId)) throw new ImmichError('list', 0);
      const json = {
        // The v3.2 filter format returns trashed assets unless trashedAt is constrained
        // (verified against a real v3.2.4); deleted photos must not reappear in the gallery.
        filter: { albumIds: { any: [albumId] }, trashedAt: { eq: null } },
        orderBy: { field: 'fileCreatedAt', direction: direction === 'asc' ? 'asc' : 'desc' },
        size,
        ...(cursor ? { cursor } : {}),
      };
      const res = await request('list', 'search/metadata', { method: 'POST', auth: 'share', json });
      const data = await readJson('list', res);
      const items = (data?.assets?.items ?? []).filter((asset) => !asset.isTrashed);
      return { items, nextCursor: data?.assets?.nextCursor ?? null };
    },

    /**
     * Open a media stream for one album asset. Only the wait for response headers is time-limited;
     * the body may stream for as long as the guest keeps downloading (abort via `signal`).
     * Resolves with the upstream Response (200/206/416); anything else throws ImmichError.
     * @param {{ kind: 'thumbnail'|'preview'|'video'|'original', id: string, range?: string,
     *   signal?: AbortSignal }} request
     */
    async fetchMedia({ kind, id, range, signal }) {
      if (!Object.hasOwn(MEDIA_PATHS, kind) || !isUuid(id)) throw new ImmichError('media', 0);
      const headers = {};
      if (
        (kind === 'video' || kind === 'original') &&
        typeof range === 'string' &&
        RANGE.test(range)
      ) {
        headers.range = range;
      }
      return openStream('media', MEDIA_PATHS[kind](id), {
        headers,
        signal,
        statuses: MEDIA_STATUSES,
      });
    },

    /**
     * How Immich would split the album into ZIP archives of about `archiveSize` bytes each
     * (trashed assets are left out; live photos bring their motion part along).
     * @param {{ albumId: string, archiveSize: number }} query
     * @returns {Promise<{ totalSize: number, archives: { size: number, assetIds: string[] }[] }>}
     */
    async downloadInfo({ albumId, archiveSize }) {
      if (!isUuid(albumId)) throw new ImmichError('download_info', 0);
      const res = await request('download_info', 'download/info', {
        method: 'POST',
        auth: 'share',
        json: { albumId, archiveSize },
      });
      const data = await readJson('download_info', res);
      if (!Array.isArray(data?.archives)) throw new ImmichError('download_info', res.status);
      const archives = data.archives.map((archive) => ({
        size: Number(archive?.size) || 0,
        assetIds: (Array.isArray(archive?.assetIds) ? archive.assetIds : []).filter(isUuid),
      }));
      const kept = archives.filter((archive) => archive.assetIds.length > 0);
      return { totalSize: kept.reduce((sum, archive) => sum + archive.size, 0), archives: kept };
    },

    /**
     * Open a ZIP stream (store-only, built on the fly by Immich) of these assets. Immich rejects
     * the whole request with 400 if any id is not readable through the link (e.g. trashed).
     * Like fetchMedia, only the wait for headers is time-limited.
     * @param {{ assetIds: string[], signal?: AbortSignal }} request
     */
    async downloadArchive({ assetIds, signal }) {
      if (!Array.isArray(assetIds) || assetIds.length === 0 || !assetIds.every(isUuid)) {
        throw new ImmichError('archive', 0);
      }
      return openStream('archive', 'download/archive', {
        method: 'POST',
        json: { assetIds },
        signal,
        statuses: ARCHIVE_STATUSES,
      });
    },

    /**
     * Move assets to the event user's trash (recoverable by the owner). The gateway never sends
     * `force`, but Immich's `asset.delete` permission also allows `force: true` deletes and
     * `POST /trash/empty`: a leaked delete key can permanently delete every asset the event
     * user owns. Keep it server-side only.
     */
    async deleteAssets(ids) {
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isUuid)) {
        throw new ImmichError('delete', 0);
      }
      await request('delete', 'assets', { method: 'DELETE', auth: 'delete', json: { ids } });
    },
  };
}
