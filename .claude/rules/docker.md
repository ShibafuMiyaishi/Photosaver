---
description: Docker and docker-compose conventions for this project
paths: "**/Dockerfile, **/docker-compose*.yml, **/docker-compose*.yaml, **/compose*.yml, **/compose*.yaml"
---

## Which compose file is which

| File | Status | Notes |
|---|---|---|
| `server/docker-compose.yml` | ACTIVE (mini PC, project `photosaver`) | Official Immich compose + 5 numbered deltas (see `CLAUDE.md`) |
| `guest-gateway/compose.yml` | ACTIVE (mini PC, project `wedding-gw`) | Tailscale sidecar + gateway; joins external network `photosaver_gw` |
| `guest-gateway/dev/compose.yml` | dev only (Mac) | Pinned dev Immich for integration tests; never deploy it |
| `immich/docker-compose.yml` | FROZEN | Old Windows validation stack (Immich + album-guard) |

## Base images

- **Immich**: official `ghcr.io/immich-app/immich-*` images only, tag from `${IMMICH_VERSION:-v3}`
  (major-pinned metatag; never `release`/`latest`). Never build or patch Immich images.
- **guest-gateway**: `node:24-alpine`, runs as the image's `node` user (uid 1000).
- **tailscale sidecar**: `tailscale/tailscale` pinned to a minor tag (e.g. `v1.102`).
- **album-guard** (FROZEN): `node:20-alpine`. Do not change.

## Dockerfile (guest-gateway, album-guard)

- No build step / no multi-stage (plain JS).
- Copy `package.json` + `package-lock.json` before sources so the install layer caches.
- Production install: guest-gateway uses `npm ci --omit=dev --ignore-scripts`.
- Exec-form `CMD ["node", "src/index.js"]` — no shell form.
- `HEALTHCHECK` / compose healthchecks: only commands present in the image (alpine has
  `wget`, not `curl`).

## Compose conventions

- **Variable substitution** via `${VAR}` from the env file next to the compose file
  (or `--env-file`). Never inline secrets. Required values use `${VAR:?message}`.
- **Ports**: Immich binds only `127.0.0.1:2283`. guest-gateway publishes no ports at all
  (it shares the sidecar's network namespace and is reached only through Funnel/serve).
  Never add other port mappings.
- **Networks**: Immich uses its `default` network plus the internal `photosaver_gw`
  (delta 5, only `immich-server` joins). The gateway reaches Immich only via
  `photosaver_gw`; never attach Redis/Postgres to it and never move the gateway onto
  `photosaver_default`.
- **Bind mounts on the mini PC**: Linux paths. Photo data on the Btrfs HDD under
  `/mnt/photo`; Postgres and gateway sqlite/state on the NVMe (`/srv/photosaver/...`).
  For HDD-backed mounts use `bind.create_host_path: false` (or the mount-guard pattern) so
  a missing HDD fails startup instead of writing to the system disk.
- **Mount markers**: `mount-guard` checks `${UPLOAD_LOCATION}/.photosaver.mount-ok`;
  guest-gateway bind-mounts `/mnt/photo/.photosaver.mount-ok`. Never remove either check.
- **`depends_on`**: keep `mount-guard: condition: service_completed_successfully` on
  `immich-server`; otherwise follow upstream.
- **Restart policy**: Immich services follow upstream (`always`), `mount-guard` is a
  one-shot (`'no'`); the gateway stack uses
  `unless-stopped` so `docker compose -p wedding-gw down` stays down.
- **Windows bind mounts** (frozen `immich/` only): forward-slash paths (`E:/Photo`).

## Exposure

Remote access is Tailscale on the host (`tailscale serve` → `127.0.0.1:2283`, tailnet-only).
The only Funnel exposure is the guest-gateway's own tagged sidecar node (`tag:wedding-gw`).
Do not add tunnel services (Cloudflare Tunnel etc.) — see `docs/tailscale.md`.

## Environment files

- `server/.env.example` → `/srv/photosaver/.env` on the mini PC.
- `guest-gateway/.env.example` → `/srv/photosaver/guest-gateway/.env` (mode 600); event
  Immich credentials go to `${GW_DATA_DIR}/immich.env` (written by `scripts/setup-event.js`).
- Frozen: `immich/.env.example` → `immich/.env`.
- Templates hold placeholders only. Never commit a real `.env`. Avoid `$` in values
  (compose interpolates it).

## Docs sync

- `server/` changes → `docs/new-server-setup.md` or `docs/operations.md` in the same commit
  (startup sequence, ports, new services, new deltas).
- `guest-gateway/compose.yml` / `Dockerfile` changes → `guest-gateway/README.md` and
  `docs/guest-gateway.md`.

## Destructive commands

Never recommend:
- `docker system prune -a` (destroys other projects' data)
- `docker volume rm` without a backup path
- `docker compose down -v` without confirming the user accepts data loss
  (the dev Immich `down -v` reset is fine on the Mac, with the warning)
- `tailscale funnel reset` / `tailscale serve reset` on the mini PC host
