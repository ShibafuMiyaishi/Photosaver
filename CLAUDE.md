# Photosaver — Claude Instructions

This repository is the workspace for a self-hosted photo-sharing system built on Immich,
running on a dedicated Linux mini PC, shared with family and friends via Tailscale.

**Design philosophy: this is a temporary event-photo drop zone, not a permanent archive.**
Original photos are intentionally NOT backed up (participants save keepers to their own
devices). Only DB dumps are duplicated. Do not add backup infrastructure for originals
unless the user explicitly changes this policy.

## Project history (three phases)

- **Phase A/B (2026-04 〜 2026-07)**: Windows + Docker Desktop validation env with
  `album-guard`, a custom Node.js auth reverse proxy (album-level passwords via
  JWT + bcrypt). Fully implemented and tested.
- **Pivot (2026-08)**: album-guard **frozen**. Immich v3 moved album asset listing to
  `POST /api/search/metadata` (bypasses path-based interception), and Immich standard
  features (multi-user accounts, quotas, password-protected shared links) cover the
  actual sharing needs. Kept in-repo as a portfolio/learning artifact.
- **Current (v2)**: dedicated Ubuntu mini PC (used OptiPlex 7070 Micro, i5-9500T/16GB)
  + external 4TB Btrfs HDD. Friends install the official Immich app and access via
  Tailscale node sharing. See `docs/architecture.md`.

## Repo layout

| Path | Status | Contents |
|---|---|---|
| `server/` | **ACTIVE** | Production compose for the mini PC (Immich v3, mount-guard, QSV) |
| `docs/` | **ACTIVE** | Japanese docs: hardware, setup, migration, operations, tailscale |
| `docs/legacy/` | archive | Old Windows/album-guard era docs |
| `album-guard/` | **FROZEN** | Custom auth proxy. Do not extend. Tests/CI may still run |
| `immich/` | FROZEN | Old Windows validation stack (kept until migration completes) |
| `scripts/` | legacy | Helper scripts for the old Windows env |
| `.claude/` | active | Claude Code config (some skills/rules target the frozen env) |

## Working rules for the ACTIVE parts

- **`server/docker-compose.yml`** is based on the official Immich release compose.
  When updating it, diff against
  `https://github.com/immich-app/immich/releases/latest/download/docker-compose.yml`
  and keep our three deltas: 127.0.0.1 port binding, `mount-guard` service,
  QSV `extends`. Never remove the mount-guard dependency — it prevents writes into
  an empty mountpoint when the HDD is missing.
- **Immich version**: `.env` uses the `v3` metatag (major-pinned). Never suggest
  unpinned `release`/`latest`, never suggest auto-updaters (Watchtower is EOL and
  incompatible with Immich's app/server version coupling). Major upgrades: read the
  official migration guide first; mobile apps update before the server.
- **DB placement**: Postgres data stays on internal NVMe ext4. Never on the HDD,
  never on Btrfs/CoW, never NTFS/exFAT, never a network share (official requirement).
- **Secrets stay in env files** (`.env`, gitignored). Never in compose, source, or docs.
- **No public exposure**: access is Tailscale-only (`tailscale serve` → 127.0.0.1:2283).
  Do not add port mappings beyond localhost, do not add Cloudflare Tunnel (its 100MB
  request cap breaks mobile video backup — verified 2026-08), do not propose Funnel
  for the Immich API. If public sharing is ever needed, the approved pattern is
  Immich Public Proxy behind Tailscale Funnel (read-only, share-links only).
- **Docs are curated**: human-facing docs live in `docs/` in Japanese. Don't create
  new doc files unless asked. When changing `server/`, update the matching doc
  (`new-server-setup.md` or `operations.md`) in the same commit.

## Working rules for the FROZEN parts

- `album-guard/` and `immich/`: bugfix-only on explicit request; no new features,
  no dependency upgrades, no TypeScript conversion. The path-scoped rules in
  `.claude/rules/` (auth.md, proxy.md) still apply if those files are ever touched.
- The skills `/album-add`, `/hash-password`, `/test-auth`, `/compose-up`,
  `/drive-check` target the frozen Windows env — warn the user before using them
  in the v2 context.

## Project-wide rules (always apply)

- **Git commits** → `.claude/rules/git.md`: every commit body lists one concise
  Japanese line per changed file. Use HEREDOC form for multi-line messages.
- **Testing / temp files** → `.claude/rules/testing.md`: all ephemeral output under
  repo-relative `tmp/` (gitignored).
- **Language**: Claude-facing files (this file, `.claude/**`) in English.
  Human-facing files (`README.md`, `docs/`, UI text) in Japanese.
  Code comments default to English; Japanese for domain-specific context.

## When to read which doc

- Buying/replacing hardware → `docs/hardware.md`
- Setting up the mini PC from zero → `docs/new-server-setup.md`
- Moving data off the old Windows env → `docs/migration-runbook.md`
- Component responsibilities / design decisions → `docs/architecture.md`
- Updates, capacity, user management, incidents → `docs/operations.md`
- Tailscale plans, friend invites, serve/Funnel → `docs/tailscale.md`

## Subagents

- `docker-debugger` — compose/networking/bind-mount/Tailscale-serve issues (still relevant)
- `auth-reviewer` — only relevant if frozen album-guard code is touched

## What not to do

- Don't extend album-guard or revive Phase 11.5 (HTML injection) — superseded.
- Don't add backup systems for photo originals (explicit design decision).
- Don't modify Immich itself — upstream images only.
- Don't commit `.env` or any file containing secrets.
- Don't run destructive git ops (`reset --hard`, `push --force`) without explicit confirmation.
- Don't recommend `docker compose down -v` without warning about data loss.
