---
description: JavaScript style conventions for guest-gateway, album-guard (frozen) and scripts
paths: "guest-gateway/**/*.js, album-guard/**/*.js, scripts/**/*.js, scripts/**/*.mjs"
---

## Per component

| | guest-gateway (ACTIVE) | album-guard (FROZEN) | `scripts/` (legacy) |
|---|---|---|---|
| Runtime | Node 24 (`node:24-alpine`, CI Node 24) | Node 20 (`node:20-alpine`, CI Node 20) | Node 20 |
| Modules | **ESM** (`"type": "module"`, `import`/`export`) | **CommonJS** (`require`/`module.exports`) | ESM `.mjs` |
| Framework | Express 5 | Express 4 | — |
| Logging | `log(level, event, fields)` from `src/log.js` (one JSON line) | `morgan` + `console.*` prefixed `[album-guard]` | `console.*` |

Do not convert album-guard to ESM, Express 5, or TypeScript (frozen: bugfix-only).

## Formatting (identical `.prettierrc` in both components)

- Prettier: `semi: true`, `singleQuote: true`, `printWidth: 100`, `trailingComma: 'all'`,
  2-space indent, LF.
- Run `npm run lint` (ESLint flat config) and `npm run format` in the component directory.

## Language level

- Use what the component's Node version supports (guest-gateway: `import.meta.dirname`,
  `node:sqlite`, `fs.openAsBlob`, global `fetch`/`FormData`).
- No TypeScript. No Babel. No bundler. Browser code in `guest-gateway/public/` is plain JS
  served as-is (libraries from `node_modules`, no CDN).

## Error handling

- `try/catch` with specific error messages — do not swallow errors silently.
- Prefer `async/await` over `.then()` chains.
- `async` functions must either return or throw — never leave a promise unawaited
  unless explicitly fire-and-forget (and commented).
- guest-gateway: never return Immich error bodies or internal URLs to clients
  (see `.claude/rules/guest-gateway.md`).

## Imports

- Top-of-file imports, grouped: Node builtins (`node:` prefix) → npm deps → local.
- Do not mutate imported modules.

## Dependencies

- guest-gateway: only the dependency set approved in `.claude/rules/guest-gateway.md`;
  anything else needs user approval. Lockfile changes also need approval.
- album-guard: no new deps, no upgrades (frozen).
- No `axios`, `node-fetch`, `lodash`, `winston`, `debug` — use built-ins.

## File conventions

- First line: path comment (e.g. `// guest-gateway/src/foo.js`), then a short description
  of the file's role (Japanese is used for these headers in guest-gateway).
- Code comments default to English; Japanese for domain-specific context.
  User-facing strings (UI, guest-visible messages) are Japanese.
