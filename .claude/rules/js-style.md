---
description: JavaScript style conventions for album-guard and scripts
paths: "album-guard/**/*.js, scripts/**/*.js, scripts/**/*.mjs"
---

## Module system

- **CommonJS only** in `album-guard/` (`require` / `module.exports`). Spec uses CJS.
- **ES Modules** (`.mjs`) are OK in `scripts/` — single-file utilities, top-level
  `await` is welcome there.

## Formatting

- **Prettier defaults** + `semi: true`, `singleQuote: true`, `printWidth: 100`.
- 2-space indent.
- Trailing commas in multi-line objects/arrays (`trailingComma: 'all'`).

## Language level

- Node 20 features OK (nullish coalescing, optional chaining, top-level await in `.mjs`).
- No TypeScript. No Babel. No bundler.

## Error handling

- `try/catch` with specific error messages — do not swallow errors silently.
- Prefer `async/await` over `.then()` chains.
- `async` functions must either return or throw — never leave a promise unawaited
  unless explicitly fire-and-forget (and commented).

## Imports

- Top-of-file `require` calls, grouped: Node builtins → npm deps → local.
- Treat `require(...)` return value as frozen — do not mutate imported modules.

## Logging

- HTTP logs: `morgan` (configured in `config.LOG_FORMAT`).
- Application logs: `console.log` / `console.warn` / `console.error`.
- Prefix all app-level logs with `[album-guard]` (per spec).
- No `debug` or `winston` deps — keep it simple.

## Dependencies

- Do NOT add new runtime deps beyond what the spec lists (`express`,
  `http-proxy-middleware`, `jsonwebtoken`, `bcryptjs`, `morgan`, `dotenv`).
- No `axios`, no `node-fetch`, no `lodash`. Use built-ins.
- Test-only deps (Vitest) are fine.

## Spec fidelity

When adding new source files, match the spec's style:
- File header one-liner comment with path (e.g., `// album-guard/src/foo.js`)
- Top-level `require` calls
- Functional exports via `module.exports = { fn1, fn2 }`
- Japanese inline comments only where the user-facing message is Japanese
  (e.g., log message strings). Code comments default to English.
