# Photosaver — Claude Instructions

This repository is the workspace for a self-hosted photo-sharing system built on Immich,
running on a dedicated Linux mini PC, shared with family and friends via Tailscale.

**Design philosophy: this is a temporary event-photo drop zone, not a permanent archive.**
Original photos are intentionally NOT backed up (participants save keepers to their own
devices). Only DB dumps are duplicated. Do not add backup infrastructure for originals
unless the user explicitly changes this policy.

## Project history

- **Phase A/B (2026-04 〜 2026-07)**: Windows + Docker Desktop validation env with
  `album-guard`, a custom Node.js auth reverse proxy (album-level passwords via
  JWT + bcrypt). Fully implemented and tested.
- **Pivot (2026-08)**: album-guard **frozen**. Immich v3 moved album asset listing to
  `POST /api/search/metadata` (bypasses path-based interception), and Immich standard
  features (multi-user accounts, quotas, password-protected shared links) cover the
  actual sharing needs. Kept in-repo as a portfolio/learning artifact.
- **Current (v2)**: dedicated mini PC running Ubuntu Server 24.04 (used OptiPlex 7070 Micro,
  i5-9500T/16GB). Immich v3; Postgres on the internal NVMe (ext4); photos on an external
  4TB Btrfs HDD at `/mnt/photo`. Friends install the official Immich app and reach it
  tailnet-only via `tailscale serve` + node sharing. See `docs/architecture.md`.
- **Events (2026-10)**: `guest-gateway`, a public guest-upload app for one event album
  (the only Funnel-exposed component — see the exception below).

## Repo layout

| Path | Status | Contents |
|---|---|---|
| `server/` | **ACTIVE** | Production compose for the mini PC (Immich v3, mount-guard, QSV, `photosaver_gw` network) + `scripts/sync-db-dumps.sh` |
| `guest-gateway/` | **ACTIVE** (feature-complete; awaiting deployment + real-device checks) | Public guest-upload app for events: Node 24, Express 5, ESM, separate compose project `wedding-gw`. Spec: `docs/guest-gateway.md`, rules: `.claude/rules/guest-gateway.md`, dev/deploy: `guest-gateway/README.md`. Server-side rollout = handoff tasks T1–T4 |
| `docs/` | **ACTIVE** | Japanese docs: architecture, hardware, setup, migration, operations, tailscale, guest-gateway |
| `docs/legacy/` | archive | Old Windows/album-guard era docs |
| `album-guard/` | **FROZEN** | Custom auth proxy. Do not extend. Tests/CI may still run |
| `immich/` | **FROZEN** | Old Windows validation stack (kept until migration completes) |
| `scripts/` | legacy | Helper scripts for the old Windows env |
| `.github/workflows/` | active | CI: lint + unit tests for album-guard (Node 20) and guest-gateway (Node 24); album-guard image build on tags |
| `.claude/` | active | Claude Code config + `handoff/` (some skills/rules target the frozen env) |

## Working rules for the ACTIVE parts

- **`server/docker-compose.yml`** is based on the official Immich release compose.
  When updating it, diff against
  `https://github.com/immich-app/immich/releases/latest/download/docker-compose.yml`
  and keep the 5 deltas numbered in its header comment: (1) 127.0.0.1 port binding,
  (2) `mount-guard` service, (3) QSV `extends`, (4) no `DB_STORAGE_TYPE`, (5) the internal
  `photosaver_gw` network on `immich-server` (guest-gateway only; never attach Redis/Postgres
  to it). Never remove the mount-guard dependency — it prevents writes into an empty
  mountpoint when the HDD is missing.
- **Mount markers**: two marker files must exist on the mounted HDD —
  `/mnt/photo/immich-library/.photosaver.mount-ok` (read by `mount-guard`, which mounts
  `${UPLOAD_LOCATION}`) and `/mnt/photo/.photosaver.mount-ok` (bind-mounted by guest-gateway).
  Never create a marker on an unmounted path (check `findmnt /mnt/photo` first).
- **Immich version**: `.env` uses the `v3` metatag (major-pinned). Never suggest
  unpinned `release`/`latest`, never suggest auto-updaters (Watchtower is EOL and
  incompatible with Immich's app/server version coupling). Major upgrades: read the
  official migration guide first; mobile apps update before the server.
- **DB placement**: Postgres data stays on internal NVMe ext4. Never on the HDD,
  never on Btrfs/CoW, never NTFS/exFAT, never a network share (official requirement).
- **Secrets stay in env files** (`.env`, gitignored; on the mini PC also the gateway's
  `${GW_DATA_DIR}/immich.env`, mode 600). Never in compose, source, or docs.
- **No public exposure**: access is Tailscale-only (`tailscale serve` → 127.0.0.1:2283).
  Do not add port mappings beyond localhost, do not add Cloudflare Tunnel (its 100MB
  request cap breaks mobile video backup — verified 2026-08), do not propose Funnel
  for the Immich API. If public sharing is ever needed, the approved pattern is
  Immich Public Proxy behind Tailscale Funnel (read-only, share-links only).
- **Exception (approved 2026-10)**: `guest-gateway` may be exposed via Tailscale Funnel,
  time-limited per event, on its OWN tagged Tailscale node (`tag:wedding-gw`) in a separate
  compose project. It holds only an album shared-link key and a delete-only API key; Immich
  stays tailnet-only. Never `tailscale funnel reset` / `serve reset` on the host — the kill
  switch is `cd ~ && docker compose -p wedding-gw down` (run `-p wedding-gw`
  commands from a directory without a compose file, never from `/srv/photosaver`).
- **Docs are curated**: human-facing docs live in `docs/` in Japanese. Don't create
  new doc files unless asked. When changing `server/`, update the matching doc
  (`new-server-setup.md` or `operations.md`) in the same commit; when changing
  `guest-gateway/`, keep `docs/guest-gateway.md` and `guest-gateway/README.md` in sync.

## Working rules for the FROZEN parts

- `album-guard/` and `immich/`: bugfix-only on explicit request; no new features,
  no dependency upgrades, no TypeScript conversion. The path-scoped rules in
  `.claude/rules/` (auth.md, proxy.md) still apply if those files are ever touched.
- The skills `/album-add`, `/hash-password`, `/test-auth`, `/compose-up`,
  `/drive-check` target the frozen Windows env — warn the user before using them
  in the v2 context. (`/hash-password` makes bcrypt hashes for album-guard; the
  guest-gateway uses scrypt via `npm run hash-password` in `guest-gateway/`.)

## Project-wide rules (always apply)

- **Git commits** → `.claude/rules/git.md`: every commit body lists one concise
  Japanese line per changed file. Use HEREDOC form for multi-line messages.
- **Testing / temp files** → `.claude/rules/testing.md`: all ephemeral output under
  repo-relative `tmp/` (gitignored). guest-gateway: `npm test` / `npm run lint` in
  `guest-gateway/`; the Immich integration tests run only with `IMMICH_IT_*` env set
  against the dev Immich (`guest-gateway/dev/compose.yml`, on a dev machine — never the mini PC).
- **Language**: Claude-facing files (this file, `.claude/**`) in English.
  Human-facing files (`README.md`, `docs/`, UI text) in Japanese.
  Code comments default to English; Japanese for domain-specific context.

## Two machines (home PC ⇄ Mac)

- **Home PC (Windows) — the main machine**: most development happens here (Docker Desktop
  for the dev Immich; shell commands in the docs are bash, i.e. Git Bash on Windows), and it
  is the only machine that can SSH to the mini PC on the same LAN — deploys, ops,
  measurements, guiding the user through the Tailscale admin console.
- **Mac (work laptop)**: used only while the user is travelling. Development only — code,
  local Docker/dev Immich, tests, docs. No SSH to the mini PC, no tailnet, no server secrets.
  Keep Windows-specific config (e.g. paths in `.claude/mcp.json`) as is; it is for the home PC.
- Server-side work prepared on the Mac is handed over through git: **`.claude/handoff/`**
  (protocol in its README, open tasks in `tasks.md`, results in `reports/`). On the home PC,
  `git pull` and read `.claude/handoff/tasks.md` when the user asks to continue server-side work.
- **This repo is public** — never commit tailnet names, `*.ts.net` hostnames, IPs, keys,
  policy files, or personal info about events/guests.

## When to read which doc

- Buying/replacing hardware → `docs/hardware.md`
- Setting up the mini PC from zero → `docs/new-server-setup.md`
- Moving data off the old Windows env → `docs/migration-runbook.md`
- Component responsibilities / design decisions → `docs/architecture.md`
- Updates, capacity, user management, incidents → `docs/operations.md`
- Tailscale plans, friend invites, serve/Funnel → `docs/tailscale.md`
- Event guest uploads (guest-gateway) → `docs/guest-gateway.md`

## Subagents

- `docker-debugger` — compose/networking/bind-mount/mount-marker/Tailscale-serve issues on
  the mini PC stack and the guest-gateway sidecar (read-only diagnostics)
- `auth-reviewer` — only relevant if frozen album-guard code is touched

## What not to do

- Don't extend album-guard or revive Phase 11.5 (HTML injection) — superseded.
- Don't add backup systems for photo originals (explicit design decision).
- Don't modify Immich itself — upstream images only.
- Don't commit `.env` or any file containing secrets.
- Don't run destructive git ops (`reset --hard`, `push --force`) without explicit confirmation.
- Don't recommend `docker compose down -v` without warning about data loss.
