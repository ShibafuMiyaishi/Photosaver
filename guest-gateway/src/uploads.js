// guest-gateway/src/uploads.js
// tus(分割・再開可能アップロード)の受信。受付前に拡張子・サイズ・空き容量(受信途中の残り分も差し引く)を
// 検査し、受信完了時にファイルの中身(マジックバイト)を判定して計測ログを出す。中身と拡張子が食い違う
// 正直なファイル(.jpg の HEIC など)は、Immich に渡すファイル名の拡張子を中身に合わせて直す。
// 受信途中のアップロードは開始した端末からしか再開できない(別の端末には存在しないのと同じ 404)。
// 取り込みモードでは完了したファイルをステージング内の importing/ に移し、onReceived で
// 取り込みキューに渡す(取り込みを諦めたファイルは取り込みキューが failed/ に移して残す)。
// 受信済みのアップロードへの再開確認(HEAD)には「完了済み」と答え、同じファイルを送り直させない。
// 起動時には、受信は終わったのに完了処理の前に止まったファイルを拾い直す(reconcile)。
// 速度検証モードでは受信後に削除する(KEEP_UPLOADS=true のときは kept/ に移して残す)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { fileTypeFromFile } from 'file-type';
import { SAFE_ID } from './importer.js';
import { log } from './log.js';

// Detected content type → extensions that belong to it; the first one is canonical (used when
// the file's own extension does not match its content). Every extension here must also be in
// ALLOWED_EXTENSIONS. Within one family (jpg/jpeg, heic/heif, mp4/m4v) any member is accepted.
export const EXTENSIONS_BY_MIME = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/heic': ['heic', 'heif'],
  'image/heif': ['heif', 'heic'],
  'image/heic-sequence': ['heic', 'heif'],
  'image/heif-sequence': ['heif', 'heic'],
  'image/avif': ['avif'],
  'video/quicktime': ['mov'],
  'video/mp4': ['mp4', 'm4v'],
  'video/x-m4v': ['m4v', 'mp4'],
  'video/3gpp': ['3gp'],
  'video/3gpp2': ['3gp'],
};

export const ALLOWED_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'heic',
  'heif',
  'png',
  'webp',
  'gif',
  'avif',
  'mov',
  'mp4',
  'm4v',
  '3gp',
]);

export const ALLOWED_MIME_TYPES = new Set(Object.keys(EXTENSIONS_BY_MIME));

// tus counts expiry from creation, so this must outlast the slowest large upload.
// Staging is purged at CLOSES_AT anyway.
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
// A create that passed the free-space check holds its full size until its `<id>.json` is on disk
// (then the disk scan counts it); a create that fails in between is forgotten after this long.
const RESERVATION_TTL_MS = 10 * 60 * 1000;
// Same status and body as @tus/utils ERRORS.FILE_NOT_FOUND, so an upload of another device looks
// exactly like one that does not exist.
const NOT_FOUND = { status_code: 404, body: 'The file for this url was not found\n' };
const UPLOAD_PATH = /^\/files\/([A-Za-z0-9_-]{1,128})\/?$/;

// Finished files live outside the tus-managed entries so tus expiry never touches them
// (@tus/file-store only expires top-level `<id>` files that have an `<id>.json` next to them):
// kept/ for inspection (KEEP_UPLOADS=true), importing/ while waiting for Immich, failed/ for
// files the importer gave up on (kept for scripts/requeue-failed.js; originals have no backup).
export const KEPT_DIR_NAME = 'kept';
export const IMPORT_DIR_NAME = 'importing';
export const FAILED_DIR_NAME = 'failed';

/** Strip path parts and control characters; keep the name readable for Immich later. */
export function sanitizeFilename(name) {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return base.slice(-200);
}

export function extensionOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/**
 * The name to give Immich for a file whose content was detected as `mime` (an allowed type).
 * Immich picks its image/video pipeline by extension, so a name whose extension does not belong
 * to the content (an MP4 called .png, a HEIC called .jpg by a messaging app) gets the canonical
 * extension of the detected type instead. Returns the name unchanged when it already fits.
 * @returns {{ filename: string, from: string, to: string } | null} null = no change needed
 */
export function correctExtension(filename, mime) {
  const allowed = EXTENSIONS_BY_MIME[mime];
  const ext = extensionOf(filename);
  if (!allowed || allowed.includes(ext)) return null;
  const base = ext ? filename.slice(0, -(ext.length + 1)) : filename;
  return { filename: `${base}.${allowed[0]}`, from: ext, to: allowed[0] };
}

function reject(status_code, body) {
  // @tus/server aborts the request with this status/body when a hook throws an object.
  return { status_code, body };
}

/** A deliberate `{status_code, body}` (ours or a tus protocol error), not an unexpected Error. */
function isTusResponse(err) {
  return (
    err !== null &&
    typeof err === 'object' &&
    !(err instanceof Error) &&
    Number.isInteger(err.status_code) &&
    typeof err.body === 'string'
  );
}

/**
 * Wrap a hook so unexpected exceptions (fs errors etc.) never reach the client: @tus/server
 * would otherwise put `error.message` (with internal paths) into the response body.
 */
function guardHook(name, fallback, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (isTusResponse(err)) throw err;
      log('error', 'upload_hook_failed', { hook: name, error: err?.message });
      throw fallback;
    }
  };
}

/** True when the HDD mount marker exists (or the check is disabled with an empty path). */
export async function mountMarkerPresent(markerPath) {
  if (!markerPath) return true;
  try {
    return (await fs.stat(markerPath)).isFile();
  } catch {
    return false;
  }
}

/** The Node request that Express already authenticated (see app.js). */
function nodeRequest(req) {
  return req.runtime?.node?.req ?? req.node?.req;
}

async function freeBytes(dir) {
  const stats = await fs.statfs(dir);
  return stats.bavail * stats.bsize;
}

async function isFile(filePath) {
  return (await fs.stat(filePath).catch(() => null))?.isFile() ?? false;
}

/** Client-reported File.lastModified (ms) from tus metadata, or null if unusable. */
function parseLastModified(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The tus uploads in the staging dir, read from disk (so it survives restarts): every top-level
 * `<id>.json` (@tus/file-store's info file) with its declared size and how many bytes its data
 * file holds (`received` is null when the data file is missing).
 * @param {string} stagingDir
 * @returns {Promise<Map<string, { size: number, received: number|null }>>}
 */
export async function scanStaging(stagingDir) {
  const result = new Map();
  const names = await fs.readdir(stagingDir).catch(() => []);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!SAFE_ID.test(id)) continue;
    let info;
    try {
      info = JSON.parse(await fs.readFile(path.join(stagingDir, name), 'utf8'));
    } catch {
      continue; // being written or removed right now, or not ours
    }
    const size = Number(info?.size);
    if (!Number.isSafeInteger(size) || size <= 0) continue;
    const stat = await fs.stat(path.join(stagingDir, id)).catch(() => null);
    result.set(id, { size, received: stat?.isFile() ? stat.size : null });
  }
  return result;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {{
 *   onReceived?: (file: { uploadId: string, deviceId: string, nickname: string,
 *     filename: string, mime: string, size: number, lastModified: number|null }) => void,
 *   findReceived?: (uploadId: string) => { device_id: string, size: number, mime: string }
 *     | undefined,
 * }} [hooks]
 *   onReceived switches on import mode: called after the file is in importing/<uploadId>.
 *   findReceived (import mode): the recorded row of a received upload, for resume checks.
 * @returns {Server & { reconcile: () => Promise<number> }} reconcile: call once at startup,
 *   before accepting requests.
 */
export function createTusServer(config, { onReceived, findReceived } = {}) {
  const datastore = new FileStore({
    directory: config.stagingDir,
    expirationPeriodInMilliseconds: FORTY_EIGHT_HOURS_MS,
  });

  // Free-space check: created uploads that are not on disk yet (id → { size, at }) and a
  // one-at-a-time queue so two creates cannot both count the same free space.
  const reservations = new Map();
  let spaceCheckQueue = Promise.resolve();

  function serializeSpaceCheck(fn) {
    const run = spaceCheckQueue.then(fn);
    spaceCheckQueue = run.catch(() => {});
    return run;
  }

  /** Bytes that uploads in progress (or just accepted) will still write into staging. */
  async function pendingBytes() {
    const onDisk = await scanStaging(config.stagingDir);
    let total = 0;
    for (const { size, received } of onDisk.values()) {
      if (received !== null) total += Math.max(0, size - received);
    }
    const now = Date.now();
    for (const [id, reservation] of reservations) {
      if (onDisk.has(id) || now - reservation.at > RESERVATION_TTL_MS) reservations.delete(id);
      else total += reservation.size;
    }
    return total;
  }

  /** Move a finished file out of tus' reach so expiry cleanup never deletes it. */
  async function moveFinished(filePath, dirName, name) {
    const targetDir = path.join(config.stagingDir, dirName);
    await fs.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, name);
    await fs.rename(filePath, target);
    // FileStore keeps its info next to the file as `<id>.json`.
    await fs.rm(`${filePath}.json`, { force: true });
    return target;
  }

  /** Detected type and the name to give Immich (extension fitted to the content). */
  async function inspect(uploadId, filePath, metadata) {
    const detected = await fileTypeFromFile(filePath).catch(() => undefined);
    const mime = detected?.mime ?? 'unknown';
    // Sanitized and extension-checked in onUploadCreate.
    let filename = metadata?.filename ?? '';
    const corrected = ALLOWED_MIME_TYPES.has(mime) ? correctExtension(filename, mime) : null;
    if (corrected) {
      filename = corrected.filename;
      log('info', 'ext_corrected', { id: uploadId, from: corrected.from, to: corrected.to, mime });
    }
    return { mime, filename };
  }

  function record(upload, mime, filename) {
    onReceived({
      uploadId: upload.id,
      deviceId: upload.metadata?.deviceId ?? '',
      nickname: upload.metadata?.nickname ?? '',
      filename,
      mime,
      size: upload.size,
      lastModified: parseLastModified(upload.metadata?.lastModified),
    });
  }

  /**
   * Everything that happens once all bytes are in (the finish hook, and startup reconcile for
   * uploads whose finish never ran). Throws a tus response when the content is not allowed.
   * @returns {Promise<string>} detected MIME type
   */
  async function finishUpload(upload, { reconciled = false } = {}) {
    const filePath = upload.storage?.path ?? path.join(config.stagingDir, upload.id);
    const { mime, filename } = await inspect(upload.id, filePath, upload.metadata);
    const elapsedMs = Date.now() - Date.parse(upload.creation_date ?? '');
    const metrics = {
      id: upload.id,
      size: upload.size,
      ext: extensionOf(upload.metadata?.filename ?? ''),
      declaredType: upload.metadata?.filetype ?? '',
      detectedType: mime,
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
      mbps:
        Number.isFinite(elapsedMs) && elapsedMs > 0
          ? Number(((upload.size * 8) / elapsedMs / 1000).toFixed(2))
          : null,
      ...(reconciled ? { reconciled: true } : {}),
    };

    if (!ALLOWED_MIME_TYPES.has(mime)) {
      await datastore.remove(upload.id).catch(() => {});
      log('warn', 'upload_rejected_content', metrics);
      throw reject(415, 'File content is not an allowed photo or video');
    }

    log('info', 'upload_finished', metrics);
    if (onReceived) {
      // Errors here surface as a 500 (guardHook) so the guest sees the upload as failed.
      let importPath;
      try {
        importPath = await moveFinished(filePath, IMPORT_DIR_NAME, upload.id);
      } catch (err) {
        // A complete upload left in place would answer tus' retry HEAD with offset == length,
        // and the client would report success for a file that is never imported. Drop it so
        // the HEAD gets 404 and the client sends the file again.
        await datastore.remove(upload.id).catch(() => {});
        throw err;
      }
      try {
        record(upload, mime, filename);
      } catch (err) {
        // Not recorded = never imported and never resumed: do not leave an orphan behind.
        await fs.rm(importPath, { force: true });
        throw err;
      }
    } else if (config.keepUploads) {
      try {
        const ext = extensionOf(filename) || 'bin';
        const keptPath = await moveFinished(filePath, KEPT_DIR_NAME, `${upload.id}.${ext}`);
        log('info', 'upload_kept', { id: upload.id, file: path.basename(keptPath) });
      } catch (err) {
        log('error', 'staging_keep_failed', { id: upload.id, error: err.message });
      }
    } else {
      await datastore.remove(upload.id).catch((err) => {
        log('error', 'staging_remove_failed', { id: upload.id, error: err.message });
      });
    }
    return mime;
  }

  const server = new Server({
    path: '/files',
    datastore,
    maxSize: config.maxFileBytes,
    relativeLocation: true,
    // Same-origin only: an empty list omits Access-Control-Allow-Origin.
    allowedOrigins: [],
    disableTerminationForFinishedUploads: true,

    // Backstop for errors outside our hooks (e.g. raw fs errors from the datastore):
    // never let `error.message` reach the client.
    onResponseError(_req, err) {
      if (isTusResponse(err)) return undefined;
      log('error', 'upload_unexpected_error', { error: err?.message });
      return { status_code: 500, body: 'Internal error\n' };
    },

    // Uploads are bound to the device that created them: for anyone else an existing upload
    // answers exactly like a missing one. After a re-login (new deviceId) tus-js-client gets
    // 404 on its resume HEAD, drops the stored URL and creates a fresh upload for the new device.
    onIncomingRequest: guardHook('incoming', reject(500, 'Internal error'), async (req, id) => {
      if (req.method === 'POST') return; // creation: the id is new
      const info = await datastore.configstore.get(id);
      if (!info) return; // tus answers 404 itself
      const session = nodeRequest(req)?.gwSession;
      if (!session?.deviceId || info.metadata?.deviceId !== session.deviceId) {
        log('warn', 'upload_device_mismatch', {
          id,
          method: req.method,
          device: session?.deviceShort,
        });
        throw NOT_FOUND;
      }
    }),

    onUploadCreate: guardHook('create', reject(503, 'Storage unavailable'), async (req, upload) => {
      if (upload.sizeIsDeferred || !Number.isFinite(upload.size) || upload.size <= 0) {
        throw reject(400, 'Upload-Length is required');
      }
      const filename = sanitizeFilename(upload.metadata?.filename);
      if (!ALLOWED_EXTENSIONS.has(extensionOf(filename))) {
        throw reject(415, 'Unsupported file type');
      }
      if (!(await mountMarkerPresent(config.mountMarker))) {
        log('warn', 'upload_rejected_mount_marker_missing', { size: upload.size });
        throw reject(503, 'Storage unavailable');
      }
      await serializeSpaceCheck(async () => {
        const free = await freeBytes(config.stagingDir);
        const pending = await pendingBytes();
        if (free - pending < upload.size + config.minFreeBytes) {
          log('warn', 'upload_rejected_disk_full', { size: upload.size, pending });
          throw reject(507, 'Server storage is full');
        }
        reservations.set(upload.id, { size: upload.size, at: Date.now() });
      });
      const session = nodeRequest(req)?.gwSession;
      log('info', 'upload_created', {
        id: upload.id,
        size: upload.size,
        ext: extensionOf(filename),
        device: session?.deviceShort,
      });
      return {
        // Identity comes from the signed session, never from client-sent metadata.
        metadata: {
          ...upload.metadata,
          filename,
          deviceId: session?.deviceId ?? '',
          nickname: session?.nickname ?? '',
        },
      };
    }),

    // v2 calls this as (req, upload); the README still documents the old (req, res, upload).
    onUploadFinish: guardHook('finish', reject(500, 'Internal error'), async (_req, upload) => {
      const mime = await finishUpload(upload);
      return { headers: { 'X-GW-Detected-Type': mime } };
    }),
  });

  // Once its `<id>.json` exists the disk scan counts the upload; drop the reservation early.
  server.on('POST_CREATE', (_req, upload) => reservations.delete(upload?.id));

  /** The recorded row of an upload this device finished (and that left staging), or null. */
  function receivedByCaller(req) {
    if (!findReceived || req.method !== 'HEAD' || !req.headers['tus-resumable']) return null;
    const id = UPLOAD_PATH.exec(new URL(req.url, 'http://gateway.invalid').pathname)?.[1];
    if (!id) return null;
    let row;
    try {
      row = findReceived(id);
    } catch (err) {
      // Fall back to tus (404): the client then sends the file again, which is safe.
      log('error', 'upload_lookup_failed', { id, error: err?.message });
      return null;
    }
    const deviceId = req.gwSession?.deviceId;
    return row && deviceId && row.device_id === deviceId ? row : null;
  }

  // tus-js-client retries a PATCH whose response was lost with a HEAD. If that PATCH finished
  // the upload, the file has already left staging (importing/, then Immich), so tus alone would
  // answer 404 and the client would send the whole file again. Answer "complete" instead
  // (offset == length → tus-js-client reports success without sending anything). Uploads
  // dropped because the move failed have no row and still get tus' 404.
  const handleTus = server.handle.bind(server);
  server.handle = async (req, res) => {
    const row = receivedByCaller(req);
    if (!row) return handleTus(req, res);
    res.writeHead(200, {
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': String(row.size),
      'Upload-Length': String(row.size),
      'Cache-Control': 'no-store',
      'X-GW-Detected-Type': row.mime,
    });
    res.end();
    return undefined;
  };

  /**
   * Startup repair for a crash between the last write and the end of the finish hook:
   * - all bytes in, finish never ran → run it now (import, or the speed-test handling);
   * - data already moved to importing/ but `<id>.json` left behind → record it if it is not
   *   recorded yet, then drop the info file;
   * - incomplete uploads stay as they are (the client resumes them).
   * Idempotent; logs each repair. Returns how many uploads it finished or recorded.
   */
  async function reconcile() {
    let repaired = 0;
    for (const [id, { size, received }] of await scanStaging(config.stagingDir)) {
      try {
        if (received === size) {
          // A rejected content type throws (415) after removing the upload, like the live hook.
          const upload = await datastore.getUpload(id);
          await finishUpload(upload, { reconciled: true });
          repaired += 1;
          log('info', 'staging_reconciled', { id, action: 'finished' });
        } else if (received === null) {
          const infoPath = path.join(config.stagingDir, `${id}.json`);
          const importPath = path.join(config.stagingDir, IMPORT_DIR_NAME, id);
          let action = 'info_removed';
          if (onReceived && (await isFile(importPath)) && !findReceived?.(id)) {
            const info = JSON.parse(await fs.readFile(infoPath, 'utf8'));
            const { mime, filename } = await inspect(id, importPath, info.metadata);
            if (!ALLOWED_MIME_TYPES.has(mime) || (await fs.stat(importPath)).size !== size) {
              // Not something the finish hook would have accepted: leave it for the operator.
              log('warn', 'staging_reconcile_skipped', { id, detectedType: mime });
              continue;
            }
            record({ id, size, metadata: info.metadata }, mime, filename);
            repaired += 1;
            action = 'recorded';
          }
          // The data is gone or already handled: the info file alone is useless (and would make
          // tus answer 410 instead of 404).
          await fs.rm(infoPath, { force: true });
          log('info', 'staging_reconciled', { id, action });
        }
      } catch (err) {
        if (isTusResponse(err)) {
          // Content not allowed: removed and logged (upload_rejected_content) like a live finish.
          log('info', 'staging_reconciled', { id, action: 'rejected' });
        } else {
          log('error', 'staging_reconcile_failed', { id, error: err?.message });
        }
      }
    }
    return repaired;
  }

  server.reconcile = reconcile;
  return server;
}

/**
 * Remove everything in the staging dir (used once the deadline has passed). failed/ is always
 * left alone: it holds originals Immich did not take, and only the operator may drop them.
 * @param {string} stagingDir
 * @param {{ keep?: string[] }} [options] further entry names to leave alone (e.g. importing/
 *   while the import queue is still working through it)
 */
export async function purgeStaging(stagingDir, { keep = [] } = {}) {
  const kept = new Set([FAILED_DIR_NAME, ...keep]);
  const entries = (await fs.readdir(stagingDir).catch(() => [])).filter((n) => !kept.has(n));
  await Promise.all(
    entries.map((name) => fs.rm(path.join(stagingDir, name), { recursive: true, force: true })),
  );
  return entries.length;
}
