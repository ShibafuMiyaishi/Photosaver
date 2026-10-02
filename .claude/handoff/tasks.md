# Tasks for the home PC

Read [`README.md`](README.md) (protocol + public-repo redaction rules) and
[`../rules/guest-gateway.md`](../rules/guest-gateway.md) first. Human-facing background:
[`docs/guest-gateway.md`](../../docs/guest-gateway.md).

Context: the user is building `guest-gateway` (public guest-upload app for an event happening
**within two weeks of 2026-10-01**). The biggest unknown is Tailscale Funnel throughput, so the
first milestone is a speed test on the real mini PC. These tasks prepare for it.

`<minipc>` = the SSH target of the mini PC (ask the user if unknown). Server paths follow
`docs/new-server-setup.md`: compose in `/srv/photosaver/`, repo clone in `/srv/photosaver/repo`,
HDD at `/mnt/photo`, `UPLOAD_LOCATION=/mnt/photo/immich-library`.

---

## T1 — Preflight checks (read-only)

Status: READY

Run over SSH, read-only. Do not change anything in this task.

1. Immich version — must be **>= 3.2.4** (security fix GHSA-q89f-h332-8q2h):
   `curl -s http://127.0.0.1:2283/api/server/version`
   (if that needs auth, use `docker inspect immich_server --format '{{.Config.Image}}'` plus
   `docker image inspect` labels). If older: do NOT upgrade; report it. The upgrade
   procedure is `docs/operations.md` (月次アップデート) and needs user approval.
2. `docker --version`, `docker compose version` (**must be >= 2.24**: the gateway compose uses
   `env_file` with `required: false`; if older, report it and stop — updating the
   `docker-compose-plugin` package needs user approval),
   `docker ps --format '{{.Names}}\t{{.Status}}'` (all Immich containers healthy?).
3. Docker networks of the Immich stack: `docker network ls --format '{{.Name}}' | grep photosaver`
   — expected `photosaver_default`; `photosaver_gw` appears only after T2b. Also report whether
   `/srv/photosaver/docker-compose.yml` differs from `/srv/photosaver/repo/server/docker-compose.yml`
   (`diff -q`; do not pull or copy).
4. Tailscale: `tailscale version` (need >= 1.38.3; record the version),
   `tailscale serve status`, `tailscale funnel status`.
   Confirm 443 → `127.0.0.1:2283` is tailnet-only and nothing is funneled.
   **Do not paste the output into the report** (it contains the tailnet hostname).
5. Storage: `findmnt /mnt/photo`, `df -h /mnt/photo /srv`.
6. Mount markers — check BOTH paths and report which exist:
   `ls -la /mnt/photo/.photosaver.mount-ok /mnt/photo/immich-library/.photosaver.mount-ok`.
   Both are expected: `mount-guard` reads the one inside `immich-library/` (it mounts
   `${UPLOAD_LOCATION}` and tests `/data/.photosaver.mount-ok`); the guest-gateway reads the
   one at `/mnt/photo/`. If the `/mnt/photo/` one is missing while `findmnt /mnt/photo` shows
   the HDD mounted, it may be created — only with the user's explicit OK (the one exception to
   this task's read-only rule): `touch /mnt/photo/.photosaver.mount-ok`. Never create a marker
   on an unmounted path. Report a missing `immich-library/` marker without fixing it.
7. Host: `nproc`, `free -h`, `uptime`, `lsb_release -d`, and `id -u` of the SSH user
   (must be 1000: the gateway container runs as uid 1000 and its files are read by compose as
   this user; report if not).
8. Repo clone: `git -C /srv/photosaver/repo status -sb` and `git -C /srv/photosaver/repo log -1 --oneline`
   (is it clean and pullable? Do not pull yet).

Report: `reports/YYYY-MM-DD-T1.md` with sanitized results (versions, pass/fail per item,
free space). Then commit + push.

---

## T2 — Tailscale admin setup for the gateway node (needs the user, in a browser)

Status: READY (needs user approval — the user performs console edits; you guide and verify)

Goal: allow a new **tagged** node `tag:wedding-gw` to use Funnel, and issue its auth key.
The gateway runs as its own Tailscale node (docker sidecar), so the host's existing serve
config is untouched.

1. Ask the user to open the admin console → **Access controls** and paste the current policy
   to you **in chat only** (never commit it). Propose a minimal diff that adds:
   ```jsonc
   "tagOwners": {
     "tag:wedding-gw": ["autogroup:admin"],
   },
   "nodeAttrs": [
     { "target": ["tag:wedding-gw"], "attr": ["funnel"] },
   ],
   ```
   merged into existing `tagOwners` / `nodeAttrs` if present. Do not change existing ACL/grants
   rules. Note for the report (sanitized): whether the policy is the default allow-all; if so,
   mention that the tagged node can be reached from the tailnet (acceptable — the sidecar runs
   userspace networking so the gateway cannot dial tailnet peers; to be verified in T3).
2. Confirm MagicDNS and HTTPS Certificates are enabled (they should be, since the host serves Immich).
3. Ask the user to generate an **auth key**: Settings → Keys → Generate auth key —
   Reusable: off, Ephemeral: off, Pre-approved: on (if device approval is enabled),
   Tags: `tag:wedding-gw`, Expiration: 30 days.
4. Store it on the mini PC only:
   ```bash
   sudo mkdir -p /srv/photosaver/guest-gateway && sudo chown $USER:$USER /srv/photosaver/guest-gateway
   git -C /srv/photosaver/repo pull --ff-only        # needs guest-gateway/.env.example (merged in PR #2)
   [ -f /srv/photosaver/guest-gateway/.env ] || \
     install -m 600 /srv/photosaver/repo/guest-gateway/.env.example /srv/photosaver/guest-gateway/.env
   # the user edits the TS_AUTHKEY= line in that file (nano) and pastes the key. Never echo it.
   ```
   Do not print the file afterwards; verify with `grep -c '^TS_AUTHKEY=tskey-' .env` only.
   T3 fills in the remaining values in this same file — never recreate it.

Report: `reports/YYYY-MM-DD-T2.md` — which steps are done (no policy text, no key). Commit + push.

---

## T2b — Give the gateway its own network to Immich (restarts immich-server briefly)

Status: READY (after T1). Needs user approval: `immich_server` is recreated (tens of seconds offline).

`server/docker-compose.yml` gained delta 5: `immich-server` also joins the internal network
`photosaver_gw`, the only network the gateway shares with Immich (Redis/Postgres stay off it).
Follow **`docs/operations.md` → 「compose 設定の反映」**:

1. `git -C /srv/photosaver/repo pull --ff-only` (stop and report if dirty/diverged).
2. Show the user `diff /srv/photosaver/docker-compose.yml /srv/photosaver/repo/server/docker-compose.yml`.
   Expected: only the header comment item 5, the comment lines above `mount-guard` (comment-only),
   the `networks:` block under `immich-server`, and the top-level `networks: gw`. If anything else differs (local edits on the server), STOP and ask.
3. With approval, follow the operations.md block exactly: back up the current file
   (`docker-compose.yml.bak`), record `docker inspect -f '{{.Name}} {{.State.StartedAt}}' immich_postgres immich_redis`,
   `cp` the file, `docker compose config -q && docker compose up -d` (if `config -q` fails, restore
   the backup and STOP), then `docker compose ps` (all healthy) and check that Immich works in the
   tailnet (open the app). Run the same `docker inspect` again: the Postgres / Redis start times
   must be unchanged (only `immich_server` is recreated); report if they changed.
4. Verify: `docker network inspect photosaver_gw --format '{{.Internal}} {{range .Containers}}{{.Name}} {{end}}'`
   → `true immich_server ` (only that container until the gateway starts).

Report: `reports/YYYY-MM-DD-T2b.md` (pass/fail, no hostnames/IPs). Commit + push.

---

## T3 — Deploy the gateway in speed-test mode and measure Funnel

Status: READY (after T1, T2 and T2b are DONE). Needs the user with phones; ask before starting containers.

The code is on main (`guest-gateway/`). Follow **`guest-gateway/README.md` →
「デプロイ」** exactly; it is the source of truth for commands. Do NOT create `immich.env` in this
task — without it the gateway runs in speed-test mode (receive, measure, delete). Key points:

1. `git -C /srv/photosaver/repo pull --ff-only` (report and stop if the clone is dirty or diverged).
2. Directories: only if the HDD marker exists (`test -f /mnt/photo/.photosaver.mount-ok`) create
   `/srv/photosaver/guest-gateway/db` and `/mnt/photo/guest-gateway/staging` (both chown 1000:1000).
   If the marker is missing, STOP and report (see T1 item 6: the gateway reads
   `/mnt/photo/.photosaver.mount-ok`; override `MOUNT_MARKER_HOST` in `.env` only after confirming
   with the user).
3. `.env`: T2 already created `/srv/photosaver/guest-gateway/.env` from `.env.example` with
   TS_AUTHKEY filled in. **Do not recreate or overwrite it** (the README's `install` line is guarded
   and skips an existing file). Fill in the remaining values in place: SESSION_SECRET
   (`openssl rand -hex 32`), GUEST_PASSWORD_HASH (via `docker run ... node scripts/hash-password.js`,
   the user types the password; never echo it), CLOSES_AT (ask the user; e.g. a few days after the
   test). Build the image from the pulled code first (README step 3 does) so the hash gets the new
   scrypt parameters (N=2^17; it must start with `scrypt:131072:`). If `.env` already holds a hash
   made earlier (`scrypt:16384:`), it still works, but regenerate it now (recommended). Time one run
   on the mini PC and put the duration in the report (docker startup included; expected ~0.3–0.5 s for
   the hash itself): `read -rs P && time (printf '%s' "$P" | docker run --rm -i guest-gateway node scripts/hash-password.js); unset P`.
   The gateway refuses to start on a malformed hash or one outside N 2^14..2^20. Keep the template defaults for GW_DATA_DIR / STAGING_DIR_HOST / MOUNT_MARKER_HOST unless
   T1 showed different paths. Verify required keys without printing values:
   `grep -cE '^(TS_AUTHKEY|GW_DATA_DIR|STAGING_DIR_HOST|SESSION_SECRET|GUEST_PASSWORD_HASH|CLOSES_AT)=.+' .env` → 6,
   `grep -c 'CHANGE_ME' .env` → 0 (the template ships placeholder/default values, so the first
   check alone does not prove T3 filled anything in), and show `grep '^CLOSES_AT=' .env` to the
   user to confirm the deadline they chose (it is not a secret; the template date is a placeholder).
   Never print or commit the rest of the file.
4. Validate first: `docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml --env-file /srv/photosaver/guest-gateway/.env config -q`
   (never print the expanded config — it contains secrets). Then
   `docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml --env-file /srv/photosaver/guest-gateway/.env up -d --build`,
   then (see the kill-switch note in item 8) `cd ~ && docker compose -p wedding-gw ps` (`guest_gateway` healthy, `guest_gateway_ts` Up — the sidecar has no healthcheck) and `cd ~ && docker compose -p wedding-gw logs --tail 50`
   (expect `staging_reconcile_done` before `listening`).
5. Exposure checks (from a phone on mobile data, not Wi-Fi):
   - the public gateway URL loads and login works;
   - Immich is still NOT reachable from outside, and still reachable inside the tailnet;
   - host `tailscale serve status` unchanged (443 → 127.0.0.1:2283, tailnet only).
6. Measurements (user + phones; you watch `logs -f`, `df -h /mnt/photo`, `top`):
   - single uploads over LTE/5G: 500 MB, 1 GB, 3 GB videos — record `upload_finished` size/elapsedMs/mbps;
   - 5 phones at once (10 uploads if possible): total throughput and failures;
   - resume: screen lock, airplane mode on/off, Wi-Fi↔LTE switch mid-upload;
   - iOS behaviour: `detectedType` for photos (HEIC vs JPEG) and videos, whether videos shrink
     (compare the logged `size` with the size shown in Photos), `lastModified` shown on screen.
     Only if the files themselves must be inspected: set `KEEP_UPLOADS=true` and recreate the gateway
     (a restart does not reload `.env`): `docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml --env-file /srv/photosaver/guest-gateway/.env up -d --no-deps --force-recreate guest-gateway`
     (files go to `staging/kept/`, see README), then set it back to `false`, recreate the same way, and delete
     `/mnt/photo/guest-gateway/staging/kept/` right after the check;
   - the IP shown under 「計測情報」 for phones on mobile data and on one shared Wi-Fi
     (needed to decide the venue-NAT lockout policy). **Two phones on different networks must show
     different addresses** (tailscale v1.102 source: Funnel sets a single `X-Forwarded-For` with the
     client's address, which `trust proxy = 1` reads). If every phone shows the same address, report
     it as a blocker: the per-IP login lockout, the login trust (24 h after a successful login), the
     per-address media/ZIP limits and ZIP plan caps would then be shared by all guests (IPv6 addresses
     in one /64 count as one address by design). Phones on one
     Wi-Fi showing one address is expected; the lockout defaults allow 20 failures / 15 min per
     address (2-min first lock) and can be tuned with `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES`
     in `.env` — recommend values in the report.
7. Pass guide: 1 GB over LTE within 15 min and 5 concurrent uploads without errors.
8. Kill-switch rehearsal: `cd ~ && docker compose -p wedding-gw down` → both `guest_gateway` and
   `guest_gateway_ts` are gone from `docker ps`, the public URL fails, Immich in tailnet OK.
   (`-p wedding-gw` commands must run from a directory without a compose file; from
   `/srv/photosaver` compose may load the Immich file instead.)
   Leave it down after the test unless the user says otherwise. Ask the user whether to keep the
   gateway's Tailscale node / auth key / funnel nodeAttr for the event (likely yes) or tear them
   down now (docs/guest-gateway.md 「終了後の後片付け」); record the answer in the report.

Report: `reports/YYYY-MM-DD-T3.md` with a measurement table (no URLs, tailnet names or IPs —
write only whether the shown IP was a public/carrier/shared address), pass/fail per item,
problems, and a recommendation (Funnel OK / fallback needed). Commit + push.

---

## T4 — Prepare the event in Immich and switch the gateway to import mode

Status: BLOCKED until T3 recommends Funnel (or the user decides on a fallback). Needs the user.

Ask the user for: album name, the dedicated event user's e-mail (a new address used only for
this; it never receives mail), the gateway deadline `CLOSES_AT` (already in `.env`), and the
shared-link expiry (`--expires`, later than `CLOSES_AT`, e.g. +1 day). Never commit these values.

1. `git -C /srv/photosaver/repo pull --ff-only`, rebuild the image
   (`docker build -t guest-gateway /srv/photosaver/repo/guest-gateway`).
2. Follow **`guest-gateway/README.md` → 「取り込みモードに切り替える」 → 「1. イベント用の Immich 準備」**: the user types the Immich
   admin password (`read -rs`), run `scripts/setup-event.js` on `--network photosaver_gw` with
   `--out /out/immich.env`. Verify only `ls -l /srv/photosaver/guest-gateway/immich.env` (mode 600)
   and `grep -c '^IMMICH_' /srv/photosaver/guest-gateway/immich.env` → 3. Never print the file.
3. Organiser password (optional but recommended): the user types a password different from the
   guest one; generate its hash like GUEST_PASSWORD_HASH (`docker run ... node scripts/hash-password.js`)
   and put it in `.env` as `ADMIN_PASSWORD_HASH=` (never echo it). Logging in with it enables deleting
   any photo.
4. Follow **「取り込みモードに切り替える」 → 「2. 窓口を作り直して確認」**: recreate `guest-gateway`, check the log shows `immich_ok`
   with version >= 3.2.4.
   If `ADMIN_PASSWORD_HASH` / `GUEST_PASSWORD_HASH` still start with `scrypt:16384:`, regenerate them
   now (new parameters, recommended) and recreate again — never print them.
5. From a phone on mobile data: log in with a nickname, upload 1 photo and 1 short video →
   the screen shows 「アルバムに追加しました」, the items appear in the album in the Immich app,
   and `cd ~ && docker compose -p wedding-gw logs guest-gateway | grep import_` shows `import_done`.
   `docker exec guest_gateway node scripts/event-status.js` shows the counts with no ⚠️ line
   (report only that it ran cleanly, or the warning text — not the counts).
   Upload the same photo again → 「同じ写真が既にアルバムにあります」.
   Open 「みんなの写真」: view, play the video, save a photo (share sheet → Photos), delete the test
   photo (own upload); with the organiser password, delete the test video.
   **Organiser vs Immich-app photos**: add one photo to the album from the Immich app (the user's own
   account) and open it with the organiser password → no 削除 button (the gateway knows the album
   owner; if the log shows `album_owner_unknown`, tapping 削除 shows 「この写真はここでは削除できません
   (Immich アプリから追加された写真です)」 instead). Delete it in the Immich app afterwards.
   **Re-login mid-upload** (there is no logout button; use a PC browser): while a large video is
   sending, delete only the session cookie `__Host-gw` in the browser's devtools (keep localStorage)
   → the page asks for the password → log in again → the file restarts from 0 and, once imported,
   shows as the new login's own upload (削除 button present); the log shows `upload_device_mismatch`.
   **Bulk save** (「まとめて保存」; needs ~40 items incl. 2–3 videos in the album, one ≥ 600 MB if possible):
   - iPhone (Safari): 「準備する」 → 「写真アプリに保存」 → share sheet shows 「〇項目を保存」 (photo-only:
     「〇枚の画像を保存」) → items appear in Photos (videos too); the second batch follows; a video
     > 200 MB is listed below with a 「保存」 button → Files app → share → 「ビデオを保存」.
     Note whether Safari reloads/crashes while preparing (memory) and the exact sheet labels.
   - 「やめる」 mid-run, reload, 「準備する」 again → continues with the rest; the 自分が送ったものは除く
     toggle changes the count; 「保存済みの記録を消す」 resets it.
   - iPhone save of a single video from the viewer → Photos.
   - Android (Chrome): 「ダウンロードを始める」 → allow multiple downloads → files show in the gallery /
     Google Photos 「Download」 folder. Also what happens if the multi-download prompt is dismissed.
     With a ≥ 600 MB video: it is listed for one-by-one saving.
   - Android via the LINE link: the panel says to open in Chrome.
   - PC: 「ZIP を作成」 → download → the ZIP opens and holds the album. If the album is > 2 GB, open a
     third part while two download → 「混み合っています」 page. Time a 2 GB part over the venue-like
     network (download speed over Funnel was not part of T3).
   - Memory constants: from the iPhone (Safari reload/crash while preparing?) and Android (tab killed,
     downloads missing?) results, recommend values for `public/bulk.js` — iOS `SHARE_BATCH_BYTES`
     300 MB / `SHARE_MAX_FILE_BYTES` 500 MB, Android `LIVE_BLOB_BUDGET_BYTES` 600 MB. Report only;
     code changes go through the Mac/dev flow.
6. Event-day login trust (tell the user; record in the report that it was explained): the login trust
   for the venue address lives in memory only. On the event day the organiser (or the user) logs in
   once **from the venue Wi-Fi** before guests arrive, and again after any gateway restart/recreate,
   so a global login pause triggered from elsewhere cannot lock the venue out
   (docs/guest-gateway.md 「ログインの総当たり対策」).
7. Leave it running or stop it as the user prefers (kill switch: `cd ~ && docker compose -p wedding-gw down`).

Report: `reports/YYYY-MM-DD-T4.md` (steps pass/fail; no album names, e-mails, URLs, keys). Commit + push.
