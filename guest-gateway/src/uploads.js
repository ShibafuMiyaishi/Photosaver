// guest-gateway/src/uploads.js
// tus(分割・再開可能アップロード)の受信。受付前に拡張子・サイズ・空き容量を検査し、
// 受信完了時にファイルの中身(マジックバイト)を判定して計測ログを出す。
// 速度検証版のため Immich への取り込みはまだ行わず、既定では受信後にファイルを削除する
// (KEEP_UPLOADS=true のときはステージング内の kept/ に移して残す)。

import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { fileTypeFromFile } from 'file-type';
import { log } from './log.js';

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

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  'image/avif',
  'video/quicktime',
  'video/mp4',
  'video/x-m4v',
  'video/3gpp',
  'video/3gpp2',
]);

// tus counts expiry from creation, so this must outlast the slowest large upload.
// Staging is purged at CLOSES_AT anyway.
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

// Finished files kept for inspection (KEEP_UPLOADS=true) live outside the tus-managed entries.
export const KEPT_DIR_NAME = 'kept';

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

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export function createTusServer(config) {
  const datastore = new FileStore({
    directory: config.stagingDir,
    expirationPeriodInMilliseconds: FORTY_EIGHT_HOURS_MS,
  });

  /** Move a finished file out of tus' reach so expiry cleanup never deletes it. */
  async function keepFinished(upload, filePath) {
    const keptDir = path.join(config.stagingDir, KEPT_DIR_NAME);
    await fs.mkdir(keptDir, { recursive: true });
    const ext = extensionOf(upload.metadata?.filename ?? '') || 'bin';
    const keptPath = path.join(keptDir, `${upload.id}.${ext}`);
    await fs.rename(filePath, keptPath);
    // FileStore keeps its info next to the file as `<id>.json`.
    await fs.rm(`${filePath}.json`, { force: true });
    return keptPath;
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
      if ((await freeBytes(config.stagingDir)) < upload.size + config.minFreeBytes) {
        log('warn', 'upload_rejected_disk_full', { size: upload.size });
        throw reject(507, 'Server storage is full');
      }
      const session = nodeRequest(req)?.gwSession;
      log('info', 'upload_created', {
        id: upload.id,
        size: upload.size,
        ext: extensionOf(filename),
        device: session?.deviceShort,
      });
      return {
        metadata: {
          ...upload.metadata,
          filename,
          deviceId: session?.deviceId ?? '',
        },
      };
    }),

    // v2 calls this as (req, upload); the README still documents the old (req, res, upload).
    onUploadFinish: guardHook('finish', reject(500, 'Internal error'), async (_req, upload) => {
      const filePath = upload.storage?.path ?? path.join(config.stagingDir, upload.id);
      const detected = await fileTypeFromFile(filePath).catch(() => undefined);
      const mime = detected?.mime ?? 'unknown';
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
      };

      if (!ALLOWED_MIME_TYPES.has(mime)) {
        await datastore.remove(upload.id).catch(() => {});
        log('warn', 'upload_rejected_content', metrics);
        throw reject(415, 'File content is not an allowed photo or video');
      }

      log('info', 'upload_finished', metrics);
      if (config.keepUploads) {
        try {
          const keptPath = await keepFinished(upload, filePath);
          log('info', 'upload_kept', { id: upload.id, file: path.basename(keptPath) });
        } catch (err) {
          log('error', 'staging_keep_failed', { id: upload.id, error: err.message });
        }
      } else {
        await datastore.remove(upload.id).catch((err) => {
          log('error', 'staging_remove_failed', { id: upload.id, error: err.message });
        });
      }
      return { headers: { 'X-GW-Detected-Type': mime } };
    }),
  });

  return server;
}

/** Remove everything in the staging dir (used once the deadline has passed). */
export async function purgeStaging(stagingDir) {
  const entries = await fs.readdir(stagingDir).catch(() => []);
  await Promise.all(
    entries.map((name) => fs.rm(path.join(stagingDir, name), { recursive: true, force: true })),
  );
  return entries.length;
}
