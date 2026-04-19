---
name: compose-up
description: Bring up the full HPSS stack (Immich + album-guard) and verify each component is healthy. Runs drive-check, then docker compose build+up, then polls health endpoints. External access is provided by Tailscale running on the host (not a compose service). Use when user says "起動" / "start" / "compose up" / "スタック起動".
allowed-tools: Bash(docker *), Bash(curl *), Bash(test *)
---

Start the full stack and confirm each component reaches a healthy state.

## Preflight

1. **Run `/drive-check`** — abort with the user-visible reason if it fails.
2. **Verify `immich/.env` exists** and contains at minimum `GUARD_JWT_SECRET` and
   `DB_PASSWORD` with non-placeholder values. If the values still contain `CHANGE_ME`,
   stop and ask the user to set them.
3. **Verify `immich/docker-compose.yml` exists** (will not exist in Phase A —
   politely inform the user that Phase B is required first).

## Steps

1. **Build and start:**
   ```bash
   cd immich && docker compose up -d --build
   ```

2. **Wait for health** — poll `docker compose ps` every 5s, up to 120s total, until
   `immich-server` and `album-guard` both report `(healthy)`.

3. **Verify endpoints:**
   ```bash
   curl -s http://localhost:3000/album-guard/health
   # expect: {"status":"ok",...}

   curl -s http://localhost:3000/api/server/ping
   # expect: Immich pong JSON
   ```

4. **Report status table** of each container:
   service | status | port | last log line

## On failure

- **album-guard unhealthy** → tail `docker compose logs --tail 30 album-guard`, look for:
  - `ENOENT` on `album-passwords.json` → drive not mounted or path wrong
  - `EADDRINUSE` on port 3000 → port conflict (suggest `GUARD_PORT=3001`)
  - `CHANGE_ME_32_CHAR` in logs → JWT secret not set
- **immich-db unhealthy** → check `DB_PASSWORD` consistency (must match across services)
- **immich-server unhealthy** → usually cold-start (wait another 60s). If still failing,
  tail its logs for migration errors.
- **Tailscale serve not responding** → out of compose's scope. Suggest user run
  `node scripts/tailscale-verify.mjs` for host-side diagnosis.

## After a successful start

Suggest the user run `/test-auth` to verify the full auth flow.

## Reference

- Troubleshooting: `@docs/operations.md`
- Env variables: `immich/.env.example`
