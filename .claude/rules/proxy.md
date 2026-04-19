---
description: Rules for the album-guard reverse-proxy layer
paths: album-guard/src/proxy.js
---

When editing `album-guard/src/proxy.js`:

## Album UUID extraction

- The regex `^/api/albums/([a-f0-9-]{36})/?` is the ONLY entry point for protection.
- Do NOT add album-id sources that bypass the check (query string, request body, etc.).

## Token header precedence

1. `X-Album-Token` header (primary)
2. `Authorization: Bearer <token>` (fallback)

Do NOT accept tokens via query string (`?token=...`). Tokens in URLs leak into:
- Server access logs
- Referer headers
- Browser history
- Third-party analytics

## Passthrough

- Non-matching paths must pass through unchanged.
- Do NOT mutate headers or body on passthrough.
- Preserve `X-Forwarded-*` (Immich uses them for rate limiting and audit logs) — keep
  `xfwd: true`.

## Upstream error handling

- `onError` callback must NOT leak upstream error details (Immich internal paths, DB
  errors, stack traces) to unauthenticated clients.
- Return a generic 502 with a correlation ID. Log the detail server-side only.

## Streaming

- Do NOT set `selfHandleResponse: true` on the main proxy. Photo/thumbnail responses
  are huge (100s of MB) and must stream. Buffering would OOM the container.
- Phase 11.5 may introduce a separate proxy instance with `selfHandleResponse` for HTML
  responses only — gate on `Content-Type` and `path`.

## WebSockets

- `ws: false` per spec. If Phase 11.5 or later enables WS proxying, re-verify
  album-guard does not break Immich's real-time features (upload progress, etc.).

## Middleware order

If adding new middleware, ensure it runs **AFTER** `albumAuthMiddleware` on protected
paths. Auth must be the first gate, not the last.

## Performance budget

- Request overhead budget: < 2ms per request (target)
- The regex + JS-object lookup is cheap. Do NOT introduce per-request filesystem
  reads, network calls, or JWT verification loops beyond the single `verifyToken` call.
