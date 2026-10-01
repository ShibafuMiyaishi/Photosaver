#!/usr/bin/env bash
# server/scripts/sync-db-dumps.sh
# Immich が毎日 02:00 に UPLOAD_LOCATION/backups/ へ書く DB ダンプを
# 内蔵 NVMe 側へもコピーする(無料でできる唯一の多重化)。
# 写真原本のバックアップは本プロジェクトでは意図的に持たない(docs/architecture.md 参照)が、
# DB ダンプだけは HDD 故障時に「何があったかの記録」を残すため NVMe にも置く。
#
# 安全装置: rsync --delete は「コピー元が空なら NVMe 側も空にする」。HDD 未マウント・故障で
# コピー元が空に見えるときにミラーを消さないよう、次の 2 つを満たさない限り DEST に触れない。
#   1. HDD 上のマウント確認マーカー(mount-guard と同じ ${UPLOAD_LOCATION}/.photosaver.mount-ok)がある
#   2. コピー元に Immich の DB ダンプ(immich-db-backup-*.sql.gz)が 1 つ以上ある
#
# セットアップ(cron、毎日 03:00):
#   crontab -e
#   0 3 * * * /srv/photosaver/scripts/sync-db-dumps.sh >> /var/tmp/photosaver-dbsync.log 2>&1

set -euo pipefail

LIBRARY="${UPLOAD_LOCATION:-/mnt/photo/immich-library}"
SRC="$LIBRARY/backups"
DEST="${DB_DUMP_MIRROR:-/srv/photosaver/db-dumps}"
MARKER="$LIBRARY/.photosaver.mount-ok"

fail() {
  echo "[sync-db-dumps] $(date -Iseconds) ERROR: $* — ミラーは変更しない: $DEST" >&2
  exit 1
}

[ -f "$MARKER" ] || fail "mount marker not found: $MARKER (HDD 未マウント?)"
[ -d "$SRC" ] || fail "dump dir not found: $SRC"

# Immich v3 のダンプ名は immich-db-backup-<日時>-v<版>-pg<版>.sql.gz(作成中は .sql.gz.tmp)
shopt -s nullglob
dumps=("$SRC"/immich-db-backup-*.sql.gz)
shopt -u nullglob
[ "${#dumps[@]}" -gt 0 ] || fail "no immich-db-backup-*.sql.gz in $SRC"

mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
echo "[sync-db-dumps] $(date -Iseconds) synced ${#dumps[@]} dump(s) -> $DEST"
