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
  admin mode (separate admin password) = can delete anything that came through the gateway
  (assets owned by the event user; photos added in the Immich app are not deletable here).
- Deadline: after it, everything is closed (login, upload, view, download).
- Out of scope for the first event: venue slideshow, uploader filter.
- Bulk save (user, 2026-10-01): phones must save into the default **Photos app** (not a ZIP);
  PCs get ZIP files.
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
  and, inside the Immich stack, must reach only the immich-server API (owner decision 2026-10-01).
  It still has internet/LAN egress through the sidecar's own default network (needed by Tailscale). Do not switch the
  gateway to `photosaver_default`. Accepted residual risk (owner decision 2026-10): a compromised gateway can reach the
  host's bridge address and the home LAN; mitigations are the non-root user (uid 1000), no shell secrets, and
  time-limited exposure. Host firewall hardening is out of scope.
- Import settings come from `${GW_DATA_DIR}/immich.env` (written by `scripts/setup-event.js`,
  loaded via `env_file` with `required: false`); without it the gateway runs in speed-test mode.
  Upload records live in sqlite at `${GW_DATA_DIR}/db` (NVMe, owned by uid 1000).

- Separate compose project under `guest-gateway/` (run with `-p wedding-gw`). Do NOT add it to
  `server/docker-compose.yml` (that file keeps only its listed deltas from upstream; the
  `photosaver_gw` network is the one gateway-related delta).
- Kill switch: `cd ~ && docker compose -p wedding-gw down` (run `-p wedding-gw` commands from a
  directory without a compose file; in `/srv/photosaver` compose may load the Immich file
  instead). NEVER suggest `tailscale funnel reset` or `tailscale serve reset` on the host as a
  way to stop the gateway.
- Sidecar uses the default userspace networking (`TS_USERSPACE=true`), so the gateway process
  cannot dial tailnet peers directly (inferred from the docker-params doc; verify).
- Staging for in-progress uploads lives on the photo HDD (e.g. `/mnt/photo/guest-gateway/staging`),
  never on the Postgres NVMe. Check the mount marker before accepting uploads.
- Never delete a guest's original unless Immich has it (`created`/`duplicate`/`trashed`): originals
  have no backup. When the importer gives up (Immich 400/413/415/422 — a 400 also comes from an
  operator switching the link's upload off or recreating it — or max attempts) the row becomes
  `failed` and the file is renamed into `staging/failed/` (left in `importing/` if that fails).
  `purgeStaging` and tus expiry never touch `failed/`; `scripts/requeue-failed.js --apply` moves
  files back to `importing/` and resets rows to `pending` (attempts 0), picked up on the next start.

## Upload pipeline (src/uploads.js, importer.js, store.js)

- tus uploads are bound to the creating device (`metadata.deviceId` from the signed session). HEAD/PATCH
  from another device → the same 404 as a missing upload (log `upload_device_mismatch`); after a re-login
  tus-js-client drops the stored URL and starts the file fresh, credited to the new device.
- HEAD for an upload this device already finished (row in the store, file gone from staging) → 200 with
  `Upload-Offset == Upload-Length` so a lost PATCH response never re-sends the file (import mode only).
- Finish order (import mode): move the data to `importing/` → record the row (queued) → remove
  `<id>.json`. A failed move or a failed record drops the upload/info file so the client's HEAD gets
  404 and re-sends; a failed info-file removal after recording is only logged
  (`staging_info_remove_failed`) — the upload succeeded and startup reconcile removes the leftover.
- Startup `reconcile()` (before listening), per top-level `<id>.json`:
  - all bytes in but finish never ran → run the finish step (`staging_reconciled` action `finished`);
    if its content is not allowed it is REMOVED like a live finish (`upload_rejected_content`, then
    `staging_reconciled` action `rejected`);
  - data file gone from staging, data in `importing/` and no row yet → inspect it; allowed type and
    full size → record it (action `recorded`) and drop the info file; otherwise LEFT IN PLACE for the
    operator, info file kept too (`staging_reconcile_skipped`);
  - data file gone and already recorded (or not in `importing/`) → drop the leftover info file
    (action `info_removed`);
  - incomplete uploads stay (the client resumes them).
  Also logs `staging_reconcile_done {repaired}`; errors → `staging_reconcile_failed` (not fatal,
  files left in place).
- The filename's extension is corrected to the detected content (`ext_corrected`); the corrected name
  goes to Immich and the guest's status list. Exception: a `.heic`/`.heif`/`.avif` name is never
  changed when file-type says `video/mp4` (it reports generic `video/mp4` for ISOBMFF brands it does
  not know, e.g. mif2/heim/heis/avci/MiHE).
- tus requests (`/files...`) with any query string → 400 `bad_request` (@tus/server takes the upload id
  from `req.url` including the query, which could address an id other than the one the route checked).
- Free-space check at upload creation: `statfs free < size + MIN_FREE_GB` → 507 (`upload_rejected_disk_full`,
  `phase: 'create'`).
  There is NO reservation and no subtraction of in-progress remainders (a guest could otherwise block
  everyone by declaring huge uploads and never sending them), so abandoned partials hold no space.
  `MIN_FREE_GB` (default 50) is the margin that also absorbs several large uploads arriving at once.
  Hard floor on every chunk: a PATCH (in `onIncomingRequest`, after the device check) with
  `statfs free < MIN_FREE_GB / 2` → 507 (`upload_rejected_disk_full`, `phase: 'patch'`), so many
  concurrent large uploads that each passed the create check cannot fill the HDD to 0 (which would
  stall Immich). One statfs per 50 MB chunk; if statfs itself fails the chunk is let through and
  `upload_free_space_check_failed` is logged (the create check and mount marker still guard the disk). The client treats 507 as permanent (「受付不可(507)— サーバーの保存容量が不足しています」).
  `scripts/event-status.js` shows in-progress count/remainder (受信途中) for information only; the scan
  (`scanStaging`) is used by reconcile and event-status, never on the request path.
- Store columns `in_flight` / `ambiguous` (added by `ALTER TABLE` on old DBs): an attempt that ended
  without a clear answer (network error, timeout, abort/shutdown, 5xx, unreadable 2xx, crash) marks the
  row ambiguous. A later `duplicate` for an ambiguous row whose asset no other row has as `created` is
  recorded as `created` with `reclaimed = 1` (`import_duplicate_reclaimed`). Column `reclaimed` (also
  added by `ALTER TABLE`): when another row later gets a genuine `created` (Immich said so) for the same
  asset, every reclaimed `created` row for it is demoted to `duplicate` in the same transaction
  (`import_reclaim_reverted {id, createdBy}`) — the guess was wrong, another device's identical upload
  was still in flight. Immich duplicate detection is per owner, so only event-user assets can match.

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
  `{"filter":{"albumIds":{"any":[ALBUM_ID]},"trashedAt":{"eq":null}},"orderBy":{"field":"fileCreatedAt","direction":"desc"},"size":1000,"cursor":<nextCursor>}`
  → `assets.items`, `assets.nextCursor` (null = end). Do not mix with the legacy flat fields (400).
  `/timeline/*` is internal API — avoid. Verified against a real v3.2.4 (2026-10-01):
  - without `trashedAt:{eq:null}` trashed assets are returned too;
  - `size` max 1000; `orderBy.field` only `fileCreatedAt` / `localDateTime` (others → 400);
  - `fileCreatedAt` is stored in whole seconds and `nextCursor` is an offset (`{"offset":N}`), so
    tied rows reorder between queries: pages can repeat AND skip assets. `src/gallery.js` lists all
    pages, dedups, re-lists in the other direction until `assetCount` is reached, sorts by
    (time, id) itself. Never expose Immich cursors to clients.
  - items carry `width`/`height`/`thumbhash`/`duration` (ms number)/`originalFileName` plus internal
    fields (`originalPath`, `ownerId`, `checksum`...) that must not reach guests.
- Album meta: `GET /api/albums/{id}` (no assets in v3 response). `assetCount` excludes trashed assets.
- Thumb/preview: `GET /api/assets/{id}/thumbnail?size=thumbnail|preview` — 200 with the image, no
  redirect (verified; the client uses `redirect: 'error'`). 404 for a moment after upload until the
  thumbnail job has run. Assets outside the shared-link album → 400.
- Video: `GET /api/assets/{id}/video/playback` (forward `Range` → 206; client needs `<video playsinline>`).
- Original: `GET /api/assets/{id}/original` (`Range` → 206; `Content-Disposition: inline; filename*=UTF-8''…`).
- ZIP (verified v3.2.4, share key works with `allowDownload`): `POST /api/download/info`
  `{albumId, archiveSize}` → `{totalSize, archives:[{size, assetIds}]}` (trashed assets left out,
  live-photo motion parts added; a part is closed once it exceeds `archiveSize`) → per part
  `POST /api/download/archive` `{assetIds}` → store-only zip stream (no Content-Length). **If any id
  is not readable through the link (e.g. trashed after planning) the whole request is 400.** Immich
  gzips the zip unless the request says `accept-encoding: identity` (the client always does).
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
6. Password: scrypt hash + `crypto.timingSafeEqual`. New hashes N=2^17, r=8, p=1 (~128 MiB, 0.2–0.5 s);
   verification uses the stored parameters (old N=2^14 hashes still work). Config refuses to start on a
   malformed hash: parameters outside N 2^14..2^20 (power of 2), r ≤ 32, p ≤ 16, ≤ 1 GiB; salt/hash not
   canonical unpadded base64url (`[A-Za-z0-9_-]`, re-encoding must give the same text); salt < 16 bytes;
   hash outside 32–64 bytes (a truncated paste). A scrypt failure at runtime (e.g. memory) is thrown,
   not treated as a wrong password: login → 503 `unavailable` + `Retry-After: 5`, log
   `login_check_failed`, NOT recorded as a failure. The login form auto-retries it like 429 `busy`
   (Retry-After 5 s + jitter, within the 45 s / 20-retry budget); 「通信エラーです(503)…」 only when
   that budget runs out.
   Checks in flight: 1 per client key, 3 per trusted key (venue Wi-Fi), 4 in total → else 429 `busy` +
   `Retry-After: 1`. The login form (`public/login-retry.js`) retries busy for up to 45 s / 20 retries
   (Retry-After + jitter growing 1 s → 3 s per retry) and shows 「混み合っています。自動でもう一度
   試しています…(n 回目)」. compose sets `UV_THREADPOOL_SIZE=8` so a
   login rush does not starve upload file I/O. Login response: `{ok, role, nickname}` (normalized).
   Login lockout per client key (IPv4, IPv6 /64), tuned for venue Wi-Fi (many guests behind one NAT):
   20 failures / 15 min → 2 min lock, doubling, cap 1 h (`LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES`).
   A key with a successful login in the last 24 h is **trusted**: it bypasses the global pause and its
   failures are not counted globally (per-key lock unchanged). 300 untrusted failures / 15 min → 5 min
   pause of untrusted logins. Trust is in memory only (lost on restart/recreate): the organiser logs in
   once from the venue Wi-Fi before guests arrive and after every gateway restart. There is no logout:
   a phone that is already logged in uses a private/incognito tab for this; any guest's successful
   login from the venue address makes it trusted as well. Trusted keys are capped at 10 000; at the
   cap the key with the fewest successes is evicted (ties: oldest success).
   Admin-guess window: only failed logins from TRUSTED keys are counted; while ≥ 300 fall within
   15 min the admin hash is not checked at all (a correct admin password gets the same 401 as a
   wrong one) until the window drops below 300 — logs `admin_check_paused` / `admin_check_resumed`;
   guest logins are unaffected. Reason: a guest-password holder becomes trusted and a success clears
   per-key failures, so without this they could guess the admin password forever. Untrusted failures
   are left out because the untrusted global window/pause already bounds them (~300 / 15 min), so
   admin guessing stays bounded (≤ ~600 / 15 min overall) and an anonymous attacker rotating
   addresses cannot keep admin login switched off — only someone who knows the guest password (or
   shares a trusted address) can pause admin checks. Docs recommend a long random admin password
   (12+ chars) different from the guest one.
   Residual risks (documented in docs 「残るリスク」): an attacker can keep the global pause on for
   untrusted keys (guests on mobile data may be unable to log in; venue pre-login avoids it); anyone
   sharing the venue address can lock new logins there with 20 wrong passwords (2 min, doubling to
   1 h, level kept 24 h; recovery = recreate the gateway, then log in again from the venue in a private
   tab); a guest-password holder (or anyone sharing a trusted address) can pause admin checks with
   300 wrong passwords / 15 min (the organiser waits for `admin_check_resumed`); a guest-password
   holder with several addresses can occupy media/ZIP slots (accepted); a
   guest-password holder can fill the HDD by really uploading (bandwidth-bound; watch event-status /
   `MIN_FREE_GB`).
   The outer express-rate-limit (30 / 15 min per IP) counts only malformed requests, never 401/429.
   `trust proxy` = `TRUST_PROXY_HOPS` (positive integer, default 1): tailscaled's serve proxy (v1.102 `ipn/ipnlocal/serve.go`
   `addProxyForwardedHeaders`, Go `ReverseProxy.Rewrite`) drops incoming `X-Forwarded-For` and sets
   it to the single source address — for Funnel the `Tailscale-Ingress-Src` the relay reported
   (source-read 2026-10-01; still confirm with `/api/whoami` in the speed test).
   `compose.yml` does NOT pass `TRUST_PROXY_HOPS` (its `environment:` list is explicit and `.env` is not
   an `env_file`), so in production it is always the default 1 — correct for tailscale serve/Funnel
   (one proxy hop). If T3 shows otherwise (all phones one address, or the proxy's own address),
   `compose.yml` must be changed to pass it; setting it in `.env` alone has no effect.
7. Cookie `__Host-gw` (`gw` when `COOKIE_SECURE=false` for local http): HttpOnly, Secure, Path=/,
   SameSite=Lax, HMAC-signed `{deviceId, nickname, role, exp}`.
   CSRF: reject `Sec-Fetch-Site: cross-site` + required custom header `X-Requested-With` on mutations
   (a cross-origin request carrying it needs a CORS preflight, which is never answered).
8. helmet with CSP `'self'` (+ `blob:`/`data:` for img/media), `Referrer-Policy: no-referrer`,
   `X-Robots-Tag: noindex, nofollow, noarchive`, `robots.txt` Disallow all.
9. Logs: method, route, status, duration, short hash of deviceId. Never keys, cookies, passwords.
10. After the deadline: all routes show the closed page / 410, staging dir is purged (except
    `importing/` while imports run, and `failed/`).

## Gallery relay contract (src/gallery.js)

- `GET /api/assets` returns the whole album at once (`{assets:[...]}`, gzip, ETag + `no-cache`);
  no client paging. `mine` = uploaded from the caller's device (created, not duplicate).
  `deletable`: guest = `mine`; admin = owned by the event user (album `albumUsers` role `owner`,
  looked up once via the share key; unknown → true, log `album_owner_unknown`). The UI hides 削除 when false.
- `GET /media/:id/thumbnail|preview|video|original` (`?download=1` on original → attachment).
  In-flight limits per device / per client key (75% of total) / total: light (thumbnail/preview)
  48/96/128, heavy (video/original) 4/24/32; ZIP streams 2/3/4. Per-address caps exist because a
  re-login gives a new deviceId. Beyond that → **429 + `Retry-After: 2`** (ZIP: busy HTML page);
  the UI must retry (plain `<img>` does not).
  A video/original stream that moves no bytes for 60 s is closed (players re-request with Range).
- A fresh upload's thumbnail is 404 until Immich's thumbnail job ran: show a placeholder
  (thumbhash) and retry later.
- `DELETE /api/assets/:id` (CSRF header required; 404 when IMMICH_DELETE_API_KEY is unset).
  Guest: only assets whose upload row from the caller's device is `created` (a `duplicate` of
  someone else's photo does not count) → else 403. Admin (`ADMIN_PASSWORD_HASH`, optional; the
  guest password is checked first so equal passwords never grant admin; admin cookies carry a
  fingerprint of the hash and are demoted to guest when it changes): any asset in the current
  album listing → else 404; not owned by the event user (e.g. added by the organiser in the Immich
  app — the delete key cannot trash it) → 403 `not_deletable` (also when Immich answers 400 for an
  admin delete; log `asset_not_deletable`), UI 「この写真はここでは削除できません(Immich アプリから
  追加された写真です)」 — delete those in the Immich app. In admin mode the viewer shows that note
  as soon as it moves to a photo with `deletable:false` (greeting: 「(管理者モード: このページから
  上がった写真を削除できます)」). Never `force` (goes to the event user's
  trash). Immich error mapping (guest AND admin, except that an admin 400 → 403 `not_deletable`):
  400/404 → 404; 401/403/5xx → logged `asset_delete_failed` + 502 (a bad key must not look like
  success).
  Success sets `deleted_at` on the rows (statuses stay, so a restore in Immich brings ownership
  and attribution back) and drops the shared listing cache.
- Re-uploading a file whose asset was trashed returns `duplicate` with the trashed id and does NOT
  re-add it to the album (verified v3.2.4). `GET /api/assets/{id}` with the share key answers 200
  for album assets and 400 for trashed ones (verified): the importer uses it to record `trashed`
  (UI explains) or, if the organiser restored it, a normal `duplicate` + clears `deleted_at`.
  The share key cannot restore from trash — the organiser restores in Immich.
- ZIP (PCs): `POST /api/download` (session + CSRF header) asks Immich for a plan with ~2 GiB parts
  (one Immich plan is shared single-flight for 10 s, so repeated taps or scripts cannot flood it),
  keeps it in memory (one per device, max 50 per client key — the oldest of that key is evicted —
  24 h, max 500) and returns `{id, totalSize, parts:[{size,count}]}`.
  `GET /download/:planId/:n` is opened by navigation, so it checks the session itself and answers
  errors as small HTML pages; it serves only the caller's plan, filters the part to what the album
  listing holds right now (plus listed assets' `livePhotoVideoId`) so a trashed asset cannot fail
  the whole ZIP, allows 2 ZIPs per device / 3 per client key / 4 in total (429 page; the slot is reserved and its
  release registered BEFORE any await, so parallel or abandoned requests cannot leak or bypass it),
  uses the heavy idle timeout,
  answers HEAD without asking Immich, and names files `photos.zip` / `photos-<n>-of-<total>.zip`.

## Client-side gotchas (iOS especially)

- No `capture` attribute (iOS opens camera only). `accept="image/*,video/*"` — do NOT list `image/heic`.
- iOS suspends the page on lock/app switch → tus resume on `visibilitychange`, Screen Wake Lock,
  persistent "keep this screen open" banner. tus `chunkSize` 50 MB (keeps Cloudflare fallback viable),
  long `retryDelays`, fingerprint = name+size+lastModified (per-device localStorage),
  `removeFingerprintOnSuccess: true`.
- Upload failures (`public/upload-retry.js`): tus' default `onShouldRetry` gives up at once while
  `navigator.onLine` is false, so ours keeps its status rules without that check. Transient
  (network, 5xx but 507, 408/409/423/429) → re-queued automatically while visible (5 s → 60 s cap,
  ±20% jitter, 10 per item), on `online` and on `visibilitychange`; permanent (507, other 4xx)
  never; 401 waits for the re-login. After an upload fails while offline (or a 401) the queue
  pauses instead of failing item after item; `navigator.onLine` alone never blocks a start (some
  in-app browsers report offline while online), and a confirmed chunk stops trusting it. A re-queued item gets a fresh `tus.Upload` (tus resets its retry
  counter only after progress) that resumes via the stored fingerprint.
- Stall watchdog: the active upload with no progress/success/error for 90 s while the page is visible
  is aborted and treated as a transient failure 「失敗(応答がありません)…」 (counts toward the
  auto-retry limit). Time while the page was hidden never counts: `visibilitychange` to hidden,
  `pagehide` and `freeze` set a flag, and the next check restarts the activity clock instead of
  aborting (iOS may run a pending check on resume before `visibilitychange` fires).
- Unreadable file (`NotReadableError`/`NotFoundError`, or a probe of the first byte fails): status
  asks the guest to pick it again; picking the same file (name+size+lastModified) reuses the row (a
  probe that finishes after the re-pick does not touch the new file). Picking a file that is already
  queued/uploading/importing is skipped with the note 「同じファイルが送信待ち・送信中・追加中のため、
  N 件は追加しませんでした」.
- Status polling: an id missing from 5 answers in a row stops being polled and shows
  「受け付けました(アルバムへの追加はサーバー側で続いています)」. After 410 (closed) every timer and
  the running upload stop.
- Nickname input `maxlength=20` (server also checks 1–20).
- Large downloads: direct navigation (`<a href>`), never fetch→blob of big files (Safari
  WebKitBlobResource error / tab killed). Exceptions, all size-capped: share-sheet saves (a File must
  be in memory) and Android bulk (blob → `<a download>`, one file fetched at a time, ≤ 500 MB per
  file; blob URLs live 60 s and their total is kept ≤ 600 MB before the next fetch).
  Photo save to Photos app: `navigator.share({files})`, file pre-fetched before the tap.
- Saving is per platform (`public/bulk.js` `saveMode()`): iPhone/iPad (UA, iPadOS via touch) with
  file sharing → share sheet into Photos (photos AND videos). Single save: one file ≤ 500 MB,
  dropped when the viewer moves on; larger, or refused by the sheet → the NEXT tap downloads it into
  Files (a download after an await is no longer a user gesture). Bulk: files fetched one at a time
  into batches of ≤ 30 files / ≤ 300 MB, ≤ 200 MB per file (a file that does not fit the current
  batch starts the next one; bigger or non-shareable ones go to a one-by-one list); one share sheet
  per tap; the button is disabled while the sheet is open. Files the relay labelled
  octet-stream get a type from the extension. Android → downloads (the share sheet has no "save to
  gallery"): single = direct navigation, bulk = sequential fetch → blob → `<a download>`.
  Android WebViews (`; wv)`, LINE, FB, Instagram) and iOS without file sharing → 'unsupported'
  ("open in Safari / Chrome" + ZIP). PCs → ZIP (single = direct download). Retries: 429 backs off
  with jitter up to 20 times, errors 6 times; 3 items failing in a row stop the run.
  Saved ids live in `localStorage` (`gw-saved-v1`, best effort; phone modes only, ZIP = whole
  album); own uploads excluded by default. Android cannot confirm a download happened (blocked
  multi-download prompt), so the end message points to 「保存済みの記録を消す」.
  Batch/size limits (iOS `SHARE_BATCH_BYTES` 300 MB batch / `SHARE_BULK_MAX_FILE_BYTES` 200 MB per
  bulk file / `SHARE_MAX_FILE_BYTES` 500 MB single, Android `LIVE_BLOB_BUDGET_BYTES` 600 MB live
  blobs) are unverified on real devices — tune the constants in `public/bulk.js` after the T4 check.
- Guide text: "keep the screen open", "if many, 10 at a time", "Options → Format → Current" (immich#20636).
