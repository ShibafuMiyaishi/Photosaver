# server/ — 本番サーバー用スタック

専用 Linux ミニ PC(Ubuntu Server 24.04)で動かす Photosaver v2 の docker compose 定義。

| ファイル | 役割 |
|---|---|
| `docker-compose.yml` | Immich v3 スタック(mount-guard + QSV 有効) |
| `.env.example` | 環境変数テンプレート(コピーして `.env` を作る) |
| `scripts/sync-db-dumps.sh` | DB ダンプを NVMe へミラーする cron 用スクリプト |

## 使い方

セットアップ手順の全体は **[docs/new-server-setup.md](../docs/new-server-setup.md)** を参照。
Windows 環境からの移行は **[docs/migration-runbook.md](../docs/migration-runbook.md)** を参照。

```bash
# 前提: hwaccel ファイルの取得(初回のみ、new-server-setup.md 手順 8)
curl -LO https://github.com/immich-app/immich/releases/latest/download/hwaccel.transcoding.yml
curl -LO https://github.com/immich-app/immich/releases/latest/download/hwaccel.ml.yml

cp .env.example .env   # 値を編集
docker compose up -d
```

旧 Windows 開発環境用のスタック(album-guard 付き)は `../immich/` に凍結保存されている。
