---
name: album-add
description: Register a new password-protected album by adding a UUID + bcrypt-hashed password to album-passwords.json without breaking existing entries. Use when the user wants to lock a new album, "アルバムにパスワードをかける", or "album-passwords.json に追加".
allowed-tools: Bash(node *), Bash(curl *), Read, Edit, Write, Glob
---

Guide the user through adding a new protected album.

## Inputs to collect (ask one at a time, unless all provided in $ARGUMENTS)

1. **Album UUID** — 36 chars, hyphenated. Obtained from the Immich Web UI URL:
   `https://photos.../albums/<uuid>`
2. **Label** — human-readable memo (optional but recommended)
3. **Password** — plaintext, will be hashed with bcrypt
4. **JWT expiry** — e.g., `24h`, `72h`, `7d`. Default `24h`.

## Workflow

1. **Validate UUID** — must match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
2. **Locate the passwords file** — read `GUARD_PASSWORDS_FILE` env; default
   `E:/Photo/guard/album-passwords.json`. If it doesn't exist, create `{}` first
   (after `/drive-check` passes).
3. **Generate bcrypt hash** — prefer the `/hash-password` skill or run the one-liner
   directly. Do not log the plaintext.
4. **Check for duplicate UUID** — if the entry already exists, confirm with the user
   before overwriting.
5. **Merge the new entry**, preserving existing keys and 2-space indentation:
   ```json
   {
     "<uuid>": {
       "label": "<label>",
       "hash": "<bcrypt-hash>",
       "expiresIn": "<expiry>"
     }
   }
   ```
6. **Write the file back** using JSON.stringify(obj, null, 2).
7. **Verify hot reload** — if album-guard is running, check its logs for:
   ```
   [album-guard] パスワード設定をロード: N アルバム
   ```

## Safety

- Run `/drive-check` first — abort if the drive is not mounted/writable.
- Never print the plaintext password in the final chat output.
- Never commit the modified JSON (it's in `.gitignore`).
- Handle JSON parse errors: if the existing file is malformed, STOP and ask the user
  to fix it manually (do not overwrite silently).

## Reference

- File spec: `@docs/password-management.md`
- Config file path invariant: `@.claude/rules/secrets.md`
