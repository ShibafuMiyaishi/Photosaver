# Photosaver (HPSS Phase 11) — Claude Instructions

This repository is the **development workspace** for a self-hosted photo storage system
built on Immich, with a Node.js reverse proxy ("album-guard") that adds album-level
password authentication. Implements Phase 11 of the HPSS spec.

## Repo at a glance

- **album-guard** (`album-guard/`) — Node.js/Express reverse proxy in front of Immich.
  JWT + bcrypt auth per album UUID. Hot-reload password config.
- **Immich stack** (`immich/docker-compose.yml`) — upstream photo management server +
  ML + db + redis + cloudflared.
- **Photo data** — lives on an **external drive** (currently `E:/Photo` on a 64GB USB
  for first-time testing). Path is stored in `PHOTO_STORAGE_PATH` env — never hardcode.
- **Docs** — human-facing docs in `docs/` (Japanese).

## Phase A vs Phase B

You are in **Phase A (setup)** when `album-guard/src/` does not exist yet.
Phase A establishes docs, rules, Claude config. **Do NOT create source code in Phase A.**

Phase B (implementation) creates album-guard source per the HPSS Phase 11 spec and
wires `immich/docker-compose.yml`, tests, and CI.

## Quick commands

- `npm test` — Vitest unit tests (run from `album-guard/`)
- `npm run lint` — ESLint
- `docker compose up -d --build album-guard` — build & start the proxy
- `docker compose logs -f album-guard` — tail logs
- `/hash-password <pw>` — bcrypt hash (skill)
- `/album-add` — register a protected album (skill)
- `/drive-check` — verify external drive (skill)
- `/compose-up` — full-stack start + health check (skill)
- `/test-auth` — E2E auth flow (skill)

## Architecture (one-liner)

Browser/mobile → Cloudflare Tunnel → **album-guard:3000** (auth check) →
**immich-server:2283**. Album API endpoints (`/api/albums/:uuid*`) are intercepted and
require `X-Album-Token` (JWT) if the UUID is listed in `album-passwords.json`.

Full detail: `@docs/architecture.md`.

## Code standards

- **Plain JavaScript, CommonJS** (`require`/`module.exports`). Do NOT convert to
  TypeScript or ESM — spec code is pre-validated JS.
- **Node.js 20** (Alpine for containers).
- **Express 4.18** + `http-proxy-middleware` ^3.0 + `jsonwebtoken` ^9 + `bcryptjs` ^2.4.
- **Formatter:** Prettier (defaults: semi, singleQuote).
- **Linter:** ESLint (recommended + security plugin).
- **Tests:** Vitest. Required for `auth.js` public functions.

## Critical invariants (NEVER violate)

1. **Secrets stay in env.** `GUARD_JWT_SECRET`, Cloudflare token — env vars only.
   Never in source, never in git-tracked files.
2. **`album-passwords.json` is NOT in git.** Lives on external drive
   (`${PHOTO_STORAGE_PATH}/guard/`), bind-mounted into the container.
3. **External drive path is a config value.** Never hardcode `E:/Photo` in source —
   read from `PHOTO_STORAGE_PATH` env or `config.js`.
4. **Drive unplug must not crash the stack.** album-guard validates the mount at
   startup (fail fast, clear message) and returns 503 if the drive disappears at runtime.
5. **No secrets in logs.** JWTs, bcrypt hashes, and plaintext passwords must never
   appear in stdout/stderr at any log level.
6. **bcrypt rounds >= 10. JWT uses HS256 only** (never `none`, never mixed algorithms).
7. **album-guard never touches photo files directly.** It only proxies API calls.
   Photo I/O is Immich's responsibility.
8. **Test code and log files go under `tmp/`.** Repo-relative `tmp/` is the workspace
   for all test artifacts, debug logs, Playwright traces, generated fixtures — never
   write to source directories. `tmp/` is gitignored. See `.claude/rules/testing.md`.
9. **Git commit messages include per-file summaries in Japanese.** Every commit body
   lists one concise Japanese line per changed file describing what changed in that
   file. See `.claude/rules/git.md`.

## File map

- `CLAUDE.md` — this file (Claude instructions, English)
- `README.md` — human overview (Japanese)
- `album-guard/` — proxy source (Phase B)
- `immich/docker-compose.yml` — stack definition (Phase B)
- `immich/.env.example` — stack env template
- `docs/` — Japanese operator/user docs
- `scripts/` — helper scripts (Phase B)
- `.claude/` — Claude Code config (settings, mcp, rules, skills, agents)
- `.env.example` — root env template

## When to read which doc

- Adding/changing album passwords → `@docs/password-management.md`
- External-drive setup / Docker file sharing → `@docs/external-drive.md`
- Start / stop / logs / troubleshoot → `@docs/operations.md`
- Component responsibilities → `@docs/architecture.md`
- Cloudflare Tunnel setup → `@docs/cloudflare-tunnel.md`
- Future Immich-UI password integration → `@docs/phase-11.5-design.md`

## Path-scoped rules

Before editing any of these, consult the matching rule file in `.claude/rules/`:

- `album-guard/src/auth.js`                 → `.claude/rules/auth.md`
- `album-guard/src/proxy.js`                → `.claude/rules/proxy.md`
- `**/Dockerfile`, `**/docker-compose*.yml` → `.claude/rules/docker.md`
- `**/.env*`, `**/album-passwords.json`     → `.claude/rules/secrets.md`
- Any `.js` source                          → `.claude/rules/js-style.md`
- Any test file / `scripts/*.mjs`           → `.claude/rules/testing.md`

## Project-wide rules (always apply)

- **Git commits**                           → `.claude/rules/git.md`
  Per-file Japanese 1-line summaries in every commit body.
- **Testing / temp files**                  → `.claude/rules/testing.md`
  All ephemeral output under `./tmp/` (gitignored), never in source directories.

## Subagents

- `auth-reviewer` — security review of JWT / bcrypt / auth code. Invoke before
  committing changes to `auth.js` or the `/album-guard/auth` endpoint.
- `docker-debugger` — docker-compose networking, bind mounts, health checks,
  Cloudflare Tunnel upstream resolution.

## Language

- Claude-facing files (this file, `.claude/**`) — English
- Human-facing files (`README.md`, `docs/*.md`, UI text, end-user error messages) — Japanese
- Code comments default to English; add Japanese only for non-obvious domain logic

## Tests

- **Unit (Vitest)** on `auth.js`: `verifyPasswordAndSign`, `verifyToken`,
  `isProtected`, hot-reload behavior, `hashPassword`.
- **E2E (Playwright MCP)** on `/album-guard/login` browser flow.
- **Manual E2E** via `/test-auth` skill (curl chain from spec 11.8).

## What not to do

- Don't add TypeScript.
- Don't add frontend frameworks — custom pages are server-rendered HTML strings per spec.
- Don't replace libraries (`express`, `http-proxy-middleware`, `jsonwebtoken`, `bcryptjs`).
- Don't modify Immich source/config — we deploy it upstream only.
- Don't commit `.env`, `album-passwords.json`, or any file containing secrets / PII.
- Don't create documentation files unless explicitly asked — docs are curated, not auto-generated.
- Don't run destructive git ops (`reset --hard`, `push --force`, `checkout --`) without explicit confirmation.
