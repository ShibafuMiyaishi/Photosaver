---
description: Test code and log files must live under the repo-relative tmp/ directory — never pollute source trees
paths: "**/*.test.js, **/*.spec.js, **/test/**, **/tests/**, **/__tests__/**, scripts/**/*.mjs, guest-gateway/scripts/**"
---

## `tmp/` workspace rule

All ephemeral artifacts — test scratch files, test output, debug logs, browser screenshots,
generated fixtures, verification scripts, anything temporary — must live under the
**repo-relative `tmp/`** directory at the repo root (gitignored, never deployed).

- In code, resolve it relative to the file, never from an absolute machine path
  (e.g. `path.resolve(import.meta.dirname, '../../../tmp/...')` in ESM,
  `path.resolve(__dirname, '..', '..', '..', 'tmp')` in CJS).
- Do NOT use the OS temp directory (`/tmp`, `os.tmpdir()`, `%TEMP%`) for project artifacts.
- Tests and verification code go in separate test files / `tmp/` scripts — never inside
  production source files.

### Current layout

```
tmp/
├─ test-output/
│  └─ guest-gateway/   guest-gateway test output (TMP_ROOT in test/helpers/server.js)
├─ test/               album-guard test fixtures (test/helpers/tmp.js)
├─ e2e*/               Playwright MCP screenshots / traces
├─ dev-immich/         dev Immich photo library (guest-gateway/dev/compose.yml)
└─ <other>/           verification scripts, logs, review patches, ...
```

Create subdirectories on demand (`fs.mkdir(dir, { recursive: true })`).

## Component specifics

- **guest-gateway**: every test that writes files imports `TMP_ROOT` from
  `test/helpers/server.js` (`tmp/test-output/guest-gateway`) and writes only below it
  (staging dirs, sqlite files, fixtures). `npm test` runs the unit tests; the Immich
  integration tests (`test/immich.integration.test.js`) run only when `IMMICH_IT_URL`
  (+ `IMMICH_IT_ADMIN_EMAIL` / `IMMICH_IT_ADMIN_PASSWORD`) point at the dev Immich —
  never at the production server.
- **album-guard** (FROZEN): `test/helpers/tmp.js` provides `mktmp()` under `tmp/`.
- **Playwright MCP**: save screenshots/traces under `tmp/e2e/` (or another `tmp/e2e-*`
  dir); `.playwright-mcp/` at the repo root is gitignored as a fallback only.

## Why

1. **Clean source trees** — no test by-products in `src/` or `scripts/`
2. **Easy log handling** — everything in one place; `rm -rf tmp/<dir>` clears it
3. **Never committed** — `.gitignore` excludes all of `tmp/`
4. **CI parity** — the same relative layout locally and in CI

## Examples

✅ Good:

```js
// guest-gateway/test/foo.test.js
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TMP_ROOT } from './helpers/server.js';

it('writes a scratch file under tmp/', async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await fs.writeFile(path.join(TMP_ROOT, `foo-${crypto.randomUUID()}.json`), '{}');
});
```

❌ Avoid:

```js
fs.writeFileSync('/tmp/my-log.json', ...);              // OS /tmp
fs.writeFileSync(os.tmpdir() + '/x.log', ...);          // outside the repo
fs.writeFileSync('./src/test-output.json', ...);        // pollutes the source tree
fs.writeFileSync('/Users/<me>/.../tmp/x.log', ...);     // absolute path (breaks on another machine)
```

## Cleanup

- `tmp/dev-immich/` holds the dev Immich library: stop the dev compose before deleting it
  (its Postgres lives in the `dev-pgdata` volume, so deleting `tmp/` does not reset the DB).
- Any other subdirectory may be deleted freely; tests recreate what they need with
  `mkdir(..., { recursive: true })`.

## When you see test or log code NOT following this convention

Refactor it as part of the current change (frozen components: only when that code is
touched for a requested bugfix). Do not leave mixed conventions in the tree.
