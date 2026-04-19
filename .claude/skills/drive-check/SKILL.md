---
name: drive-check
description: Validate that the external drive holding photo data and album-passwords.json is mounted, writable, has adequate free space, and is shared with Docker Desktop. Run this before any stack-start, album-add, or backup operation. Use when user asks "ドライブ確認" / "drive check" / or before `/compose-up`.
allowed-tools: Bash(*)
---

Validate the external drive at the configured path (default `E:/Photo`, overridable via
`PHOTO_STORAGE_PATH` env).

## Checks (run all, report each)

1. **Path exists and is a directory**
   ```bash
   DRIVE="${PHOTO_STORAGE_PATH:-E:/Photo}"
   test -d "$DRIVE" && echo "✅ path exists: $DRIVE" || echo "❌ path missing: $DRIVE"
   ```

2. **Writable** — create and remove a marker file
   ```bash
   MARKER="$DRIVE/.drive-check-tmp-$$"
   touch "$MARKER" 2>/dev/null && rm "$MARKER" && echo "✅ writable" || echo "❌ not writable"
   ```

3. **Free space** — warn if < 5 GB
   On Windows (bash): use `df -h "$DRIVE"` or PowerShell `Get-PSDrive`. Parse available
   space, warn if under 5 GB.

4. **Expected layout** — confirm subdirectories exist; offer to create them if missing:
   - `$DRIVE/immich-library/` (Immich `UPLOAD_LOCATION`)
   - `$DRIVE/guard/` (holds `album-passwords.json`)

5. **Docker Desktop file sharing** — probe by bind-mounting:
   ```bash
   docker run --rm -v "$DRIVE":/x alpine ls /x 2>&1
   ```
   If empty / error, the drive is NOT shared. Tell the user:
   > Add `E:\` to Docker Desktop → Settings → Resources → File sharing, then Apply & Restart.

6. **Marker file** (optional, if `/drive-check` was run before):
   `$DRIVE/.drive-check` exists → record of first-time setup.

## Output format

- Green `✅` for passing checks
- Red `❌` for failures, with a **concrete fix** (not just "check your setup")
- End with an overall **PASS** / **FAIL** verdict
- On FAIL, refuse to proceed to `/compose-up` or `/album-add` automatically

## Never

- Never run `rm -rf` or any destructive command during the check.
- Never write outside `$PHOTO_STORAGE_PATH`.
- Never proceed to use the drive if a check fails — escalate to the user.

## Reference

See `@docs/external-drive.md` for the full setup guide.
