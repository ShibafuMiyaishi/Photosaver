# Cross-machine handoff (Mac ⇄ home PC)

The user works on this repo from two machines with different capabilities. Git is the only
channel between them.

| Machine | Can do | Cannot do |
|---|---|---|
| **Mac** (work laptop, macOS) | Write code, run local Docker (incl. a local dev Immich), tests, docs, commit/push | SSH to the mini PC, join the tailnet, hold server secrets |
| **Home PC** | SSH to the mini PC (same LAN), run ops/deploy commands, help the user with the Tailscale admin console, measure | — (normal dev work is fine too) |

How to tell where you are: if `ssh` to the mini PC works (or the user says you are on the home PC),
you are the home PC. On macOS under `/Users/fumiyaishibashi/` you are the Mac.

## Protocol

1. **Mac → home PC**: the Mac writes tasks in [`tasks.md`](tasks.md) and pushes.
2. **Home PC**: `git pull`, read `tasks.md`, do the tasks whose status is `READY`, in order.
   Ask the user before anything marked *needs user approval* and before any destructive or
   outward-facing action.
3. **Home PC → Mac**: write one report per task run to `reports/YYYY-MM-DD-<task-id>.md`
   (template below), set the task's status in `tasks.md` to `DONE` / `BLOCKED`, commit, push.
4. **Mac**: `git pull`, read the reports, continue development, update `tasks.md`.

Only the Mac edits task *definitions*; the home PC only changes the `Status:` line and writes
reports. This avoids merge conflicts. Always `git pull --rebase` before pushing.

## ⚠️ This repository is PUBLIC

Reports and tasks are committed to a public GitHub repo. NEVER write any of these:

- Tailscale auth keys, API keys, Immich keys, passwords, `.env` contents
- tailnet name, full `*.ts.net` hostnames, IP addresses (public or 100.x), MAC addresses
- the Tailscale policy file contents (describe the change instead)
- names, dates, venues, or any personal information about the event or its guests

Write placeholders such as `<tailnet>`, `<minipc>`, `<redacted>`. Measurements, versions,
pass/fail results and sanitized error messages are fine.

## Server-side guardrails (home PC)

- Read `CLAUDE.md` first. In particular: never `tailscale funnel reset` / `tailscale serve reset`
  (the host's 443 serve publishes Immich to the tailnet), never `docker compose down -v`,
  never touch `server/docker-compose.yml` deltas, never put Postgres on the HDD.
- Do not upgrade Immich, change the Tailscale policy, or create keys without the user's go-ahead.
- Secrets go only into `.env` files on the mini PC (mode 600), never into git.

## Report template

```markdown
# <task-id> report — YYYY-MM-DD (home PC)

Result: PASS | FAIL | PARTIAL
## What was done
- ...
## Findings (sanitized)
- ...
## Problems / decisions needed from the user
- ...
## Next suggested step
- ...
```
