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
3. Docker network of the Immich stack: `docker network ls --format '{{.Name}}' | grep photosaver`
   — expected `photosaver_default` (the gateway will join it as an external network).
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
   install -m 600 /dev/null /srv/photosaver/guest-gateway/.env
   # the user pastes:  TS_AUTHKEY=tskey-auth-...   into that file (nano). Never echo it.
   ```
   Do not print the file afterwards; verify with `grep -c '^TS_AUTHKEY=' .env` only.

Report: `reports/YYYY-MM-DD-T2.md` — which steps are done (no policy text, no key). Commit + push.

---

## T3 — Deploy the speed-test build and measure Funnel

Status: BLOCKED — waiting for the Mac to push `guest-gateway/` (tus upload-to-disk build +
sidecar compose). This task will be rewritten with exact commands when that lands.

Planned outline (for awareness only — don't execute yet):

1. `git -C /srv/photosaver/repo pull`, start `guest-gateway` with `docker compose -p wedding-gw ...`.
2. Confirm the public URL works from a phone on mobile data (not Wi-Fi), and that Immich is
   still NOT reachable from outside and still reachable inside the tailnet.
3. Measurements (the user + a few phones; you watch server logs/disk/CPU):
   1 GB video over LTE (time it, compute Mbps), also 500 MB and 3 GB; 5 phones at once;
   resume after screen lock / airplane mode / Wi-Fi↔LTE switch; iOS behaviour
   (HEIC/JPEG, video compression, `lastModified`); the client IP seen by the app (`X-Forwarded-For`).
4. Pass criteria (guide): 1 GB over LTE within 15 min and 5 concurrent uploads without errors.
5. Kill-switch rehearsal: `docker compose -p wedding-gw down` → public URL fails, Immich in tailnet OK.
