---
description: Docker and docker-compose conventions for this project
paths: "**/Dockerfile, **/docker-compose*.yml, **/docker-compose*.yaml"
---

## Base images

- **album-guard**: `node:20-alpine` (per spec). Do NOT switch to `node:20-slim` or
  Debian-based without a documented reason.
- **Immich**: use the official `ghcr.io/immich-app/immich-*` images.
- **cloudflared**: `cloudflare/cloudflared:latest` (official).

## Dockerfile

- No multi-stage needed for album-guard (no build step). Keep it flat per spec.
- `npm install --omit=dev` for production images.
- Copy `package.json` before `src/` so npm-install layer caches independently.
- `EXPOSE 3000` for album-guard (internal only, not mapped publicly).
- `CMD ["node", "src/index.js"]` — no shell form.

## docker-compose.yml

- **Variable substitution** via `${VAR}` from `.env`. Never inline secrets.
- **Windows bind mounts**: use forward-slash paths (`E:/Photo`), never backslash.
- **`album-passwords.json`**: bind-mount from host (not a Docker volume) — user needs
  to edit from the host.
- **`depends_on` with `condition: service_healthy`** (per spec) — critical for
  immich-server cold start.
- **`healthcheck`**: only use commands that exist in the image (alpine has `wget`,
  not `curl` by default).
- **Networks**: single `default` network is sufficient. Do not create custom networks
  unless a real isolation requirement exists.
- **Restart policy**: `restart: always` for long-running services.

## Profiles

For optional services (e.g., cloudflared in local-only mode), use compose profiles:

```yaml
cloudflared:
  profiles: ["public"]
  # ...
```

- Local-only: `docker compose up -d`
- Public: `docker compose --profile public up -d`

## Environment files

- Location: `immich/.env` (adjacent to the compose file).
- Template: `immich/.env.example` — committed, placeholder values only.
- Never commit the real `.env`.

## Docs sync

When modifying `docker-compose.yml`, also update `docs/operations.md` if:
- Startup sequence changes
- New ports are exposed
- A new service is added (add troubleshooting entry too)

## Destructive commands

Never recommend:
- `docker system prune -a` (destroys other projects' data)
- `docker volume rm` without a backup path
- `docker compose down -v` without confirming the user accepts data loss
