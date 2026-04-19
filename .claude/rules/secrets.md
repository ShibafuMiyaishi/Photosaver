---
description: Secrets and sensitive file handling
paths: "**/.env, **/.env.*, !**/.env.example, **/album-passwords.json, **/*.pem, **/*.key"
---

When working with any of these files:

## Never commit

- `.gitignore` blocks them, but double-check before `git add -A` or `git commit -a`.
- If you accidentally staged one, use `git restore --staged <file>` and then check
  `git status` to confirm.

## Never print to chat

- Do not `cat`, `Read`, or `echo` `.env` contents in responses.
- If the user asks to show the `.env`, warn first and ask for explicit confirmation.
- Do not quote secret values back even as "for verification".

## Template files (`.env.example`)

- Use placeholder values only (e.g., `CHANGE_ME_32_CHAR_RANDOM`,
  `your-cloudflare-tunnel-token-here`).
- Real secrets live ONLY in the non-`.example` version, which is gitignored.

## Rotation

If a secret leaks (committed, logged, printed anywhere):

1. Generate a new value immediately (`openssl rand -hex 32` for JWT secrets).
2. Update the deployment env.
3. For `GUARD_JWT_SECRET`: all outstanding JWTs are invalidated, so users must
   re-authenticate. Mention this in the commit / incident note.
4. For DB passwords: also update `DB_PASSWORD` in the Postgres volume init or reset.

## album-passwords.json

- Contains bcrypt hashes (not plaintext), but STILL treat as sensitive.
- `hash + GUARD_JWT_SECRET` together would let an attacker mint tokens offline.
- Preferred location: on the external drive (`${PHOTO_STORAGE_PATH}/guard/`).
- Bind-mounted into the container, not shipped in the image.

## Line endings

- All `.env*` files must be LF, not CRLF. `.gitattributes` enforces this.
- Docker compose + Node `dotenv` can misparse CRLF (invisible trailing `\r` in values).

## Logging

- Never include secret values in `console.log`, `morgan` formats, or error responses.
- Morgan's default `combined` format logs the `Authorization` header — add a custom
  token filter if you use that format in production.
