---
description: Spec, verified Immich v3 API facts, and security invariants for the guest-gateway (public guest upload app)
paths: "guest-gateway/**, docs/guest-gateway.md"
---

Human-facing spec and runbook: `docs/guest-gateway.md` (Japanese). This file holds the
implementation-level facts and invariants. Research date: 2026-10-01, Immich **v3.2.4**.

## What it is

A small Node app that lets event guests (no Immich account, no Tailscale) upload photos and
videos into ONE Immich album, browse/download the whole album, and delete their own uploads.
It is the ONLY publicly exposed component (Tailscale Funnel on its own tagged node).
Immich itself stays tailnet-only. Do not extend album-guard for this; it is a new component.

## Fixed decisions (from the user, 2026-10-01)

- Guests: shared password + nickname (asked once). Session lasts until the deadline.
- Scope: whole album viewable/downloadable by every guest. No quota.
- Delete: guest = only assets uploaded from their own device (deviceId in session);
  admin mode (separate admin password) = can delete anything.
- Deadline: after it, everything is closed (login, upload, view, download).
- Out of scope for the first event: venue slideshow, uploader filter. ZIP download only if time allows.
- Stack: Node 24 LTS (`node:24-alpine`), ESM, Express 5, `node:sqlite`,
  `@tus/server` + `@tus/file-store`, `helmet`, `express-rate-limit`, `file-type`;
  browser: `tus-js-client`, `photoswipe` (served from node_modules, no CDN);
  dev: `vitest`, `eslint`, `prettier`. These dependencies were approved as a set — anything
  beyond this list still needs user approval.

## Architecture

```
guest browser → https://<TS_HOSTNAME>.<tailnet>.ts.net (Funnel :443)
  → ts sidecar (tailscale/tailscale, tag:wedding-gw, TS_SERVE_CONFIG with AllowFunnel)
  → guest-gateway (network_mode: service:<ts sidecar>, listens on 127.0.0.1:8080)
  → internal docker network `photosaver_gw` (external to this project) → http://immich-server:2283
```

- `photosaver_gw` is declared in `server/docker-compose.yml` (delta 5: `internal: true`, only
  `immich-server` joins). Redis and Postgres must never join it — the gateway is public-facing
  and must reach nothing but the Immich API (owner decision 2026-10-01). Do not switch the
  gateway to `photosaver_default`.
- Import settings come from `${GW_DATA_DIR}/immich.env` (written by `scripts/setup-event.js`,
  loaded via `env_file` with `required: false`); without it the gateway runs in speed-test mode.
  Upload records live in sqlite at `${GW_DATA_DIR}/db` (NVMe, owned by uid 1000).

- Separate compose project under `guest-gateway/` (run with `-p wedding-gw`). Do NOT add it to
  `server/docker-compose.yml` (that file keeps only its listed deltas from upstream; the
  `photosaver_gw` network is the one gateway-related delta).
- Kill switch: `docker compose -p wedding-gw down`. NEVER suggest `tailscale funnel reset` or
  `tailscale serve reset` on the host as a way to stop the gateway.
- Sidecar uses the default userspace networking (`TS_USERSPACE=true`), so the gateway process
  cannot dial tailnet peers directly (inferred from the docker-params doc; verify).
- Staging for in-progress uploads lives on the photo HDD (e.g. `/mnt/photo/guest-gateway/staging`),
  never on the Postgres NVMe. Check the mount marker before accepting uploads.

## Credentials (env only, never in repo, HTML, URLs, or logs)

1. `IMMICH_SHARE_KEY`: key of an ALBUM shared link created by a **dedicated event Immich user**,
   with `allowUpload:true, allowDownload:true, showMetadata:true`, NO Immich password,
   `expiresAt` = deadline + margin. Send it ONLY as header `x-immich-share-key` (never `?key=`).
2. `IMMICH_DELETE_API_KEY`: API key of the same dedicated user with permission `asset.delete` only.
   Deletion requires asset ownership, and shared-link uploads are owned by the link creator —
   so link creator and API-key owner MUST be the same user.
3. Guest password hash, admin password hash (scrypt), cookie HMAC secret.

## Verified Immich v3.2.4 API facts (source-read; re-verify if Immich version changes)

- Shared-link auth: header `x-immich-share-key` or `?key=`. With a shared link, only routes marked
  `sharedLink: true` work. **The link password is checked only by `GET /shared-links/me` and
  `POST /shared-links/login`** — every other route works with the key alone. Treat the key as a
  master key for the album.
- Upload: `POST /api/assets` multipart. Required: `assetData`, `fileCreatedAt`, `fileModifiedAt`
  (ISO-8601 with timezone). Optional: `filename`, `duration` (ms), `isFavorite`, `visibility`,
  `livePhotoVideoId`, `metadata`, `sidecarData`. `deviceId`/`deviceAssetId` were REMOVED in v3.0.0
  — never send them. Response `{status:"created"|"duplicate", id}` (201/200).
  Via shared link the server auto-adds the asset (also duplicates) to the link's album.
  **Do NOT send `x-immich-checksum`**: that path returns duplicate early and skips the album add.
  No server body-size limit, no chunked/resumable upload in Immich.
- EXIF dates override the client `fileCreatedAt`; sending `File.lastModified` is enough.
- List: `POST /api/search/metadata` with
  `{"filter":{"albumIds":{"any":[ALBUM_ID]}},"orderBy":{"field":"fileCreatedAt","direction":"desc"},"size":200,"cursor":<nextCursor>}`
  → `assets.items`, `assets.nextCursor` (null = end). Do not mix with the legacy flat fields (400).
  `/timeline/*` is internal API — avoid.
- Album meta: `GET /api/albums/{id}` (no assets in v3 response).
- Thumb/preview: `GET /api/assets/{id}/thumbnail?size=thumbnail|preview` (may 302 — follow or rewrite).
- Video: `GET /api/assets/{id}/video/playback` (forward `Range`; client needs `<video playsinline>`).
- Original: `GET /api/assets/{id}/original`.
- ZIP: `POST /api/download/info` `{albumId, archiveSize}` → for each archive
  `POST /api/download/archive` `{assetIds}` (streamed zip).
- Delete: `DELETE /api/assets` `{ids:[...]}` with `x-api-key` (no `force` → goes to trash).
- Immich must be **>= v3.2.4** (GHSA-q89f-h332-8q2h: SVG upload → ImageMagick RCE, reachable via
  shared-link upload).

## Security invariants (MUST hold)

1. Never expose the share key or API key to the client; never forward client cookies/auth
   headers to Immich; never relay `/shared-links/me` responses (contains the plaintext password).
   Do not use a cookie jar on the upstream HTTP client (immich-drop bug: one login unlocked everyone).
2. Fixed route allowlist. Everything else → 404. Never return Immich error bodies or internal URLs.
3. Asset ids: UUID regex; `size` param: enum only. Delete only ids recorded in our DB with the
   caller's deviceId (admin role excepted).
4. Upload files are streamed end-to-end (tus chunks to disk → `fs.openAsBlob` + `FormData` + `fetch`).
   Never read a whole file into memory.
5. File type allowlist checked by extension AND magic bytes (`file-type`):
   jpg jpeg heic heif png webp gif avif mov mp4 m4v 3gp. Reject SVG, PDF, archives. Max 4 GB per file.
6. Password: scrypt hash + `crypto.timingSafeEqual`. Login lockout per IP (/64 for IPv6):
   5 failures / 15 min → lock, doubling, cap 24 h; global failure spike → temporary pause.
   `trust proxy` = 1 (tailscaled overwrites `X-Forwarded-For`; verify the real client IP in the speed test).
7. Cookie `__Host-sid`: HttpOnly, Secure, Path=/, SameSite=Lax, HMAC-signed `{deviceId, nickname, role, exp}`.
   CSRF: exact `Origin` match + reject `Sec-Fetch-Site: cross-site` + required custom header on mutations.
8. helmet with CSP `'self'` (+ `blob:`/`data:` for img/media), `Referrer-Policy: no-referrer`,
   `X-Robots-Tag: noindex, nofollow, noarchive`, `robots.txt` Disallow all.
9. Logs: method, route, status, duration, short hash of deviceId. Never keys, cookies, passwords.
10. After the deadline: all routes show the closed page / 410, staging dir is purged.

## Client-side gotchas (iOS especially)

- No `capture` attribute (iOS opens camera only). `accept="image/*,video/*"` — do NOT list `image/heic`.
- iOS suspends the page on lock/app switch → tus resume on `visibilitychange`, Screen Wake Lock,
  persistent "keep this screen open" banner. tus `chunkSize` 50 MB (keeps Cloudflare fallback viable),
  long `retryDelays`, fingerprint = name+size+deviceId, `removeFingerprintOnSuccess: true`.
- Large downloads: direct navigation (`<a href>`), never fetch→blob (Safari WebKitBlobResource error).
  Photo save to Photos app: `navigator.share({files})`, file pre-fetched before the tap.
- Guide text: "keep the screen open", "if many, 10 at a time", "Options → Format → Current" (immich#20636).
