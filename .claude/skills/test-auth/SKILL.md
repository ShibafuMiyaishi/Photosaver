---
name: test-auth
description: Run the end-to-end album-guard authentication test suite (T1-T7 from HPSS spec section 11.8) — health, passthrough, 401 on unauthed access, successful auth, token-based access, wrong-password rejection, unprotected-album passthrough. Use after `/compose-up` or when user says "認証テスト" / "E2E test" / "verify auth".
allowed-tools: Bash(curl *), Bash(node *), Read
---

Execute the E2E auth test suite from the HPSS spec.

## Prerequisites

- Stack running (run `/compose-up` first if uncertain).
- At least one protected album registered in `album-passwords.json` (see
  `/album-add` to register one if none exist).

## Arguments (if provided in `$ARGUMENTS`)

Format: `<protected-uuid> <password> [<unprotected-uuid>]`

If arguments are missing:
- Read `album-passwords.json`, pick the first UUID as `<protected-uuid>`, and ask the
  user for the plaintext password.
- Leave `<unprotected-uuid>` optional (T7 is skipped if absent).

## Test cases (spec 11.8)

**T1 Health** — `curl http://localhost:3000/album-guard/health`
→ expect HTTP 200, JSON `{"status":"ok",...}`

**T2 Passthrough** — `curl http://localhost:3000/api/server/ping`
→ expect HTTP 200, Immich pong response

**T3 401 unauthed** — `curl http://localhost:3000/api/albums/<protected-uuid>`
→ expect HTTP 401, JSON with `error: "Album is password protected"`

**T4 Auth** — `curl -X POST http://localhost:3000/album-guard/auth -H 'Content-Type: application/json' -d '{"albumId":"<uuid>","password":"<pw>"}'`
→ expect HTTP 200, JSON with a non-empty `token` field. Capture `$TOKEN`.

**T5 Authed access** — `curl -H "X-Album-Token: $TOKEN" http://localhost:3000/api/albums/<protected-uuid>`
→ expect HTTP 200, Immich album JSON

**T6 Wrong password** — same as T4 with a wrong password
→ expect HTTP 401, `error: "パスワードが違います"`

**T7 Unprotected album** (if UUID provided) — `curl http://localhost:3000/api/albums/<unprotected-uuid>`
→ expect HTTP 200 (passthrough)

## Reporting

- Print one line per test: `T1 PASS` / `T3 FAIL (got 200, expected 401)` etc.
- On FAIL: include the exact command and actual response body (truncate if > 200 chars).
- End with a summary line: `X/Y tests passed`.

## Safety

- Do NOT echo the plaintext password back in the final report.
- Do NOT write test output to `album-passwords.json` or any persistent state.
- The `$TOKEN` is ephemeral — do not log or persist it.

## Reference

Spec text: HPSS Phase 11 追補 §11.8
