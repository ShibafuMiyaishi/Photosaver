---
name: hash-password
description: Generate a bcrypt hash (10 rounds) for a plaintext password so it can be pasted into album-passwords.json. Use this whenever the user needs to create or rotate an album password and asks for a hash, or mentions "パスワードハッシュ" / "bcrypt".
allowed-tools: Bash(node *), Bash(npx *), Bash(curl *)
---

Generate a bcrypt hash for the password `$ARGUMENTS` using 10 rounds (the project standard).

## Which method to use

**Method A — via album-guard API (preferred when the container is running):**

```bash
curl -s -X POST http://localhost:3000/album-guard/hash \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ARGUMENTS\"}"
```

**Method B — Node.js one-liner (works when album-guard is down):**

Run from `album-guard/` so `bcryptjs` resolves from `node_modules`:

```bash
cd album-guard && node -e "require('bcryptjs').hash(process.argv[1], 10).then(console.log)" "$ARGUMENTS"
```

## Safety

- Output **only the hash string** — no quotes, no trailing comment, no surrounding prose.
- **Never echo the plaintext password back** in the response.
- If `$ARGUMENTS` contains special characters (`$`, backticks, double-quotes, spaces), warn
  and suggest passing via stdin or a temp file instead.
- If `$ARGUMENTS` is empty, prompt the user for the password.

## Where to put the hash

The hash goes into `E:\Photo\guard\album-passwords.json`:

```json
{
  "<album-uuid>": {
    "label": "optional memo",
    "hash": "<paste the hash here>",
    "expiresIn": "24h"
  }
}
```

See also: `@docs/password-management.md`.
