---
description: Secrets and sensitive file handling
paths: "**/.env, **/.env.*, !**/.env.example, **/immich.env, **/album-passwords.json, **/*.pem, **/*.key"
---

When working with any of these files:

## Where secrets live

| Secret | Location (never in git) |
|---|---|
| Immich `DB_PASSWORD` | `/srv/photosaver/.env` on the mini PC |
| guest-gateway `TS_AUTHKEY`, `SESSION_SECRET`, `GUEST_PASSWORD_HASH`, `ADMIN_PASSWORD_HASH` | `/srv/photosaver/guest-gateway/.env` (mode 600) |
| guest-gateway `IMMICH_SHARE_KEY`, `IMMICH_DELETE_API_KEY`, `IMMICH_ALBUM_ID` | `${GW_DATA_DIR}/immich.env` (mode 600, written by `scripts/setup-event.js`) |
| FROZEN album-guard `GUARD_JWT_SECRET`, `album-passwords.json` | old Windows env (`immich/.env`, external drive) |

The Mac holds no server secrets (dev values only, e.g. dev Immich credentials under `tmp/`).

## Never commit

- `.gitignore` blocks them, but double-check before `git add -A` or `git commit -a`.
- If you accidentally staged one, use `git restore --staged <file>` and then check
  `git status` to confirm.
- The repo is public: also never commit tailnet names, `*.ts.net` hosts, IPs, auth keys,
  or Tailscale policy contents.

## Never print to chat

- Do not `cat`, `Read`, or `echo` `.env` / `immich.env` contents in responses.
- If the user asks to show one, warn first and ask for explicit confirmation.
- Do not quote secret values back even as "for verification". Verify presence with
  counts instead (e.g. `grep -c '^TS_AUTHKEY=tskey-' .env`).

## Template files (`.env.example`)

- Placeholder values only (e.g., `CHANGE_ME_64_HEX`).
- Real secrets live ONLY in the non-`.example` version, which is gitignored.

## Rotation

If a secret leaks (committed, logged, printed anywhere):

1. Generate a new value immediately (`openssl rand -hex 32` for `SESSION_SECRET`).
2. Update the deployment env and recreate the affected container.
3. Per secret:
   - `SESSION_SECRET`: all guest sessions are invalidated (guests log in again).
   - Guest/admin password: re-hash with `npm run hash-password` (scrypt) or the image's
     `scripts/hash-password.js`; share the new password out of band.
   - `IMMICH_SHARE_KEY` / `IMMICH_DELETE_API_KEY`: delete the shared link / API key in
     Immich and create new ones as the SAME dedicated event user (link creator and API-key
     owner must match), then update `immich.env`. Do not re-run `setup-event.js` for this —
     it creates a new user and album.
   - `TS_AUTHKEY`: revoke it in the Tailscale admin console.
   - `DB_PASSWORD`: the Postgres volume keeps the old credential — change it inside
     Postgres too, or the DB will refuse connections.
   - FROZEN album-guard `GUARD_JWT_SECRET`: outstanding JWTs become invalid.
4. Mention the rotation in the commit / incident note (without the values).

## album-passwords.json (FROZEN album-guard)

- Contains bcrypt hashes (not plaintext), but STILL treat as sensitive:
  `hash + GUARD_JWT_SECRET` together would let an attacker mint tokens offline.
- Bind-mounted into the container from the external drive, never shipped in the image.

## Line endings

- All `.env*` files must be LF, not CRLF. `.gitattributes` enforces this.
- Docker compose and env parsers can misparse CRLF (invisible trailing `\r` in values).
- Avoid `$` in values: compose interpolates it.

## Logging

- Never include secret values, cookies, share keys, or passwords in logs or error
  responses. guest-gateway logs go through `src/log.js` (one JSON line per event) — pass
  only non-secret fields (e.g. a short hash of the deviceId).
- FROZEN album-guard: Morgan's `combined` format logs the `Authorization` header — filter it.
