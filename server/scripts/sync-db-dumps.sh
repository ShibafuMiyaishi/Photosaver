#!/usr/bin/env bash
# server/scripts/sync-db-dumps.sh
# Immich が毎日 02:00 に UPLOAD_LOCATION/backups/ へ書く DB ダンプを
# 内蔵 NVMe 側へもコピーする(無料でできる唯一の多重化)。
# 写真原本のバックアップは本プロジェクトでは意図的に持たない(docs/architecture.md 参照)が、
# DB ダンプだけは HDD 故障時に「何があったかの記録」を残すため NVMe にも置く。
#
# セットアップ(cron、毎日 03:00):
#   crontab -e
#   0 3 * * * /srv/photosaver/scripts/sync-db-dumps.sh >> /var/log/photosaver-dbsync.log 2>&1

set -euo pipefail

SRC="${UPLOAD_LOCATION:-/mnt/photo/immich-library}/backups"
DEST="${DB_DUMP_MIRROR:-/srv/photosaver/db-dumps}"

if [ ! -d "$SRC" ]; then
  echo "[sync-db-dumps] ERROR: dump dir not found: $SRC (HDD 未マウント?)" >&2
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
echo "[sync-db-dumps] $(date -Iseconds) synced $(ls -1 "$DEST" | wc -l) dump(s) -> $DEST"
