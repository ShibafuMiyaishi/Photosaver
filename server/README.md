# server/ — 本番サーバー用スタック

専用 Linux ミニ PC(Ubuntu Server 24.04)で動かす Photosaver v2 の docker compose 定義。

| ファイル | 役割 |
|---|---|
| `docker-compose.yml` | Immich v3 スタック(mount-guard + QSV 有効、guest-gateway 用の内部ネットワーク `photosaver_gw`) |
| `.env.example` | 環境変数テンプレート(コピーして `.env` を作る) |
| `scripts/sync-db-dumps.sh` | DB ダンプを NVMe へミラーする cron 用スクリプト(マーカーかダンプが無ければミラーに触れずエラー終了) |

公式 compose からの変更点は `docker-compose.yml` 冒頭のコメントに番号付きで列挙している
(127.0.0.1 バインド / mount-guard / QSV / `DB_STORAGE_TYPE` 未設定 / `photosaver_gw`)。
mount-guard は `UPLOAD_LOCATION`(HDD 上の `immich-library`)直下のマーカーファイル
`.photosaver.mount-ok` が無いと本体の起動を止める。ただし mount-guard が走るのは `docker compose up` の
ときだけ(OS 起動時の自動再起動では走らない)なので、Docker を HDD マウント後に起動させる systemd drop-in も
入れる(new-server-setup.md 手順 6)。

公式との差分は上の 5 点のほか、番号を付けていない小さな違い(`name`、`IMMICH_VERSION` の既定値、
`depends_on` の書式、Valkey の digest / healthcheck)をヘッダーに注記している。

## 使い方

セットアップ手順の全体は **[docs/new-server-setup.md](../docs/new-server-setup.md)** を参照。
Windows 環境からの移行は **[docs/migration-runbook.md](../docs/migration-runbook.md)** を参照。
変更をミニ PC へ反映する手順は [docs/operations.md](../docs/operations.md) の「compose 設定の反映」。

```bash
# 前提: hwaccel ファイルの取得(初回のみ、new-server-setup.md 手順 8)
curl -LO https://github.com/immich-app/immich/releases/latest/download/hwaccel.transcoding.yml
curl -LO https://github.com/immich-app/immich/releases/latest/download/hwaccel.ml.yml

cp .env.example .env   # 値を編集
# HDD 上の immich-library と mount-guard 用マーカー(new-server-setup.md 手順 6・8)
test -f /mnt/photo/.photosaver.mount-ok && mkdir -p /mnt/photo/immich-library \
  && touch /mnt/photo/immich-library/.photosaver.mount-ok
docker compose up -d
```

イベント用のゲスト用アップロード窓口は別の compose プロジェクト(`../guest-gateway/`)で、
このスタックの `photosaver_gw` ネットワーク経由で immich-server だけに接続する
([docs/guest-gateway.md](../docs/guest-gateway.md))。

旧 Windows 開発環境用のスタック(album-guard 付き)は `../immich/` に凍結保存されている。
