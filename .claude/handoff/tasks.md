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
2. `docker --version`, `docker compose version`,
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
6. Mount marker — check BOTH paths and report which exist:
   `ls -la /mnt/photo/.photosaver.mount-ok /mnt/photo/immich-library/.photosaver.mount-ok`.
   (Known doc inconsistency: setup doc creates the marker at `/mnt/photo/`, but `mount-guard`
   mounts `${UPLOAD_LOCATION}` and tests `/data/.photosaver.mount-ok`, i.e. inside
   `immich-library/`. Just report; do not fix.)
7. Host: `nproc`, `free -h`, `uptime`, `lsb_release -d`.
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
   Expected: only the header comment item 5, the `networks:` block under `immich-server`, and the
   top-level `networks: gw`. If anything else differs (local edits on the server), STOP and ask.
3. With approval: `cp` the file, `cd /srv/photosaver && docker compose up -d`, then
   `docker compose ps` (all healthy) and check that Immich works in the tailnet (open the app).
4. Verify: `docker network inspect photosaver_gw --format '{{.Internal}} {{range .Containers}}{{.Name}} {{end}}'`
   → `true immich_server ` (only that container until the gateway starts).

Report: `reports/YYYY-MM-DD-T2b.md` (pass/fail, no hostnames/IPs). Commit + push.

---

## T3 — Deploy the speed-test build and measure Funnel

Status: READY (after T1, T2 and T2b are DONE). Needs the user with phones; ask before starting containers.

The code is on main (`guest-gateway/`). Follow **`guest-gateway/README.md` →
「デプロイ」** exactly; it is the source of truth for commands. Do NOT create `immich.env` in this
task — without it the gateway runs in speed-test mode (receive, measure, delete). Key points:

1. `git -C /srv/photosaver/repo pull --ff-only` (report and stop if the clone is dirty or diverged).
2. Directories: only if the HDD marker exists (`test -f /mnt/photo/.photosaver.mount-ok`) create
   `/srv/photosaver/guest-gateway/db` and `/mnt/photo/guest-gateway/staging` (both chown 1000:1000).
   If the marker is missing, STOP and report (T1 item 6 notes a marker-location inconsistency;
   the gateway expects `/mnt/photo/.photosaver.mount-ok` by default, override with
   `MOUNT_MARKER_HOST` in `.env` only after confirming with the user).
3. `.env`: T2 already created `/srv/photosaver/guest-gateway/.env` from `.env.example` with
   TS_AUTHKEY filled in. **Do not recreate or overwrite it** (the README's `install` line is guarded
   and skips an existing file). Fill in the remaining values in place: SESSION_SECRET
   (`openssl rand -hex 32`), GUEST_PASSWORD_HASH (via `docker run ... node scripts/hash-password.js`,
   the user types the password; never echo it), CLOSES_AT (ask the user; e.g. a few days after the
   test). Keep the template defaults for GW_DATA_DIR / STAGING_DIR_HOST / MOUNT_MARKER_HOST unless
   T1 showed different paths. Verify required keys without printing values:
   `grep -cE '^(TS_AUTHKEY|GW_DATA_DIR|STAGING_DIR_HOST|SESSION_SECRET|GUEST_PASSWORD_HASH|CLOSES_AT)=.+' .env` → 6,
   `grep -c 'CHANGE_ME' .env` → 0 (the template ships placeholder/default values, so the first
   check alone does not prove T3 filled anything in), and show `grep '^CLOSES_AT=' .env` to the
   user to confirm the deadline they chose (it is not a secret; the template date is a placeholder).
   Never print or commit the rest of the file.
4. `docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml --env-file /srv/photosaver/guest-gateway/.env up -d --build`,
   then `docker compose -p wedding-gw ps` (`guest_gateway` healthy, `guest_gateway_ts` Up — the sidecar has no healthcheck) and `docker compose -p wedding-gw logs --tail 50`.
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
     Only if the files themselves must be inspected: set `KEEP_UPLOADS=true` and restart
     (files go to `staging/kept/`, see README), then set it back to `false`, restart, and delete
     `/mnt/photo/guest-gateway/staging/kept/` right after the check;
   - the IP shown under 「計測情報」 for phones on mobile data and on one shared Wi-Fi
     (needed to decide the venue-NAT lockout policy).
7. Pass guide: 1 GB over LTE within 15 min and 5 concurrent uploads without errors.
8. Kill-switch rehearsal: `docker compose -p wedding-gw down` → public URL fails, Immich in tailnet OK.
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
2. Follow **`guest-gateway/README.md` → 「イベント用の Immich 準備(本番)」**: the user types the Immich
   admin password (`read -rs`), run `scripts/setup-event.js` on `--network photosaver_gw` with
   `--out /out/immich.env`. Verify only `ls -l /srv/photosaver/guest-gateway/immich.env` (mode 600)
   and `grep -c '^IMMICH_' immich.env` → 3. Never print the file.
3. Follow **「取り込みモードに切り替える」**: recreate `guest-gateway`, check the log shows `immich_ok`
   with version >= 3.2.4.
4. From a phone on mobile data: log in with a nickname, upload 1 photo and 1 short video →
   the screen shows 「アルバムに追加しました」, the items appear in the album in the Immich app,
   and `docker compose -p wedding-gw logs guest-gateway | grep import_` shows `import_done`.
   Upload the same photo again → 「同じ写真が既にアルバムにあります」.
5. Leave it running or stop it as the user prefers (kill switch: `docker compose -p wedding-gw down`).

Report: `reports/YYYY-MM-DD-T4.md` (steps pass/fail; no album names, e-mails, URLs, keys). Commit + push.
