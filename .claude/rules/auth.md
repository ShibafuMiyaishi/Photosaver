---
description: Security-critical rules for album-guard authentication code
paths: album-guard/src/auth.js
---

When editing `album-guard/src/auth.js`, these invariants MUST hold:

## JWT

1. **Secret source**: ONLY from `config.JWT_SECRET` (which reads `GUARD_JWT_SECRET` env).
   Never a default literal in code. Never derived from user input.
2. **Algorithm**: HS256 only. Never pass `algorithms: ['none']` or mixed HS256 + RS256
   to `jwt.verify`. The `jsonwebtoken` default for `verify` already rejects `none`, but
   do not loosen this.
3. **Expiry (`exp`)**: Always set via `expiresIn`. Always verified (default behavior).
4. **Token binding**: `verifyToken(token, albumId)` MUST compare
   `payload.albumId === albumId`. A token signed for album A must not authorize album B.
5. **Return values**: On failure, return `null` or `false` — never an error object with
   details (could leak internal state to 401 responses).

## bcrypt

1. **Salt rounds >= 10.** Spec uses 10. Do not reduce.
2. **Comparison**: ALWAYS `bcrypt.compare(plain, hash)`. Never `===` on hashes.
3. **No logging** of `rawPassword`, `hash`, or `entry` objects. Only log `albumId` and
   `entry.label` (if present).

## Password file I/O

1. **Path from config**: `config.PASSWORDS_FILE`. Never from user input.
2. **JSON.parse errors**: Caught, logged as warn, state reset to empty map (so the
   proxy still runs, just without protection). The spec does this — preserve the
   behavior.
3. **Hot reload**: `fs.watch` with a 200ms `setTimeout` debounce. Do NOT remove the
   debounce — filesystems emit watch events during write-in-progress.

## Logging & error messages

- 401 responses: keep messages generic
  (`"Album is password protected"` is fine — do not add details like
  "wrong password" vs "album not found").
- Never include JWT fragments, bcrypt hashes, or plaintext passwords in any log.

## Before committing changes here

Invoke the `auth-reviewer` subagent for a focused security review:

```
Use the auth-reviewer agent to review album-guard/src/auth.js for security issues.
```
