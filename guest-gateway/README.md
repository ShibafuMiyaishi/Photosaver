# guest-gateway

イベントのゲスト(Immich アカウントも Tailscale も無い人)が、リンク + 合言葉だけで
写真・動画をアップロードできる窓口。設計と運用は [docs/guest-gateway.md](../docs/guest-gateway.md)、
実装ルールは [.claude/rules/guest-gateway.md](../.claude/rules/guest-gateway.md)。

> **現在は速度検証版**: tus で受信 → 中身を判定 → 計測ログを出して削除するところまで。
> Immich への取り込み・閲覧・削除はまだ無い。

## 構成

| パス | 内容 |
|---|---|
| `src/index.js` | 起動・定期処理(期限切れアップロードの掃除、受付終了時のステージング削除) |
| `src/app.js` | ルート定義(ここに無いものは 404)、セキュリティヘッダー、CSRF 対策、期限切れ時の 410 |
| `src/auth.js` | 合言葉の scrypt 照合、HMAC 署名付きセッション Cookie |
| `src/uploads.js` | tus 受信(拡張子・サイズ・空き容量の検査、中身の判定、計測ログ) |
| `public/` | ゲスト用画面(ビルド工程なし) |
| `compose.yml` / `ts-config/serve.json` | Tailscale サイドカー(Funnel で 443 公開)+ 窓口 |

## 開発(Mac)

```bash
cd guest-gateway
npm ci
npm test          # Vitest(実アプリを起動して tus でアップロードまで確認)
npm run lint
```

ローカルで画面を触る場合:

```bash
mkdir -p ../tmp/dev-staging
HASH=$(printf '%s' 'dev-password-123' | node scripts/hash-password.js)
SESSION_SECRET=$(openssl rand -hex 32) GUEST_PASSWORD_HASH="$HASH" \
CLOSES_AT=2026-12-31T23:59:00+09:00 STAGING_DIR=../tmp/dev-staging \
COOKIE_SECURE=false MIN_FREE_GB=1 npm start
# → http://127.0.0.1:8080
```

## 速度検証版のデプロイ(ミニPC / 自宅PCから SSH で実施)

前提: Tailscale 管理画面の設定(`tag:wedding-gw` と funnel の許可)と認証キーの発行が済んでいること
([docs/guest-gateway.md](../docs/guest-gateway.md) の準備手順 2)。

```bash
# 1. コードを更新
git -C /srv/photosaver/repo pull

# 2. ディレクトリ(ステージングは写真 HDD 上)
#    HDD が外れていると /mnt/photo は空のシステムディスク上のディレクトリになり、mkdir すると
#    そこに書き込まれてしまう。HDD 上にだけあるマーカーで確認してから作る
#    ('HDD not mounted' と出たらここで中止し、HDD のマウントを先に直す)
if test -f /mnt/photo/.photosaver.mount-ok; then
  mkdir -p /srv/photosaver/guest-gateway /mnt/photo/guest-gateway/staging
  sudo chown 1000:1000 /mnt/photo/guest-gateway/staging   # コンテナは uid 1000 (node) で動く
else
  echo 'HDD not mounted'
fi
#    窓口コンテナにもこのマーカーを読み取り専用で渡す(無ければ起動しない・受付も止める)

# 3. .env を作る(権限 600。値は表示・コミットしない)
install -m 600 /srv/photosaver/repo/guest-gateway/.env.example /srv/photosaver/guest-gateway/.env
#    TS_AUTHKEY / SESSION_SECRET / GUEST_PASSWORD_HASH / CLOSES_AT を埋める
#    (MOUNT_MARKER_HOST は上のマーカーのパス。既定値のままでよい)
openssl rand -hex 32                                         # → SESSION_SECRET
docker build -t guest-gateway /srv/photosaver/repo/guest-gateway
read -rs P && printf '%s' "$P" | docker run --rm -i guest-gateway node scripts/hash-password.js; unset P
#                                                            # → GUEST_PASSWORD_HASH

# 4. 起動
docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml \
  --env-file /srv/photosaver/guest-gateway/.env up -d --build
docker compose -p wedding-gw ps
docker compose -p wedding-gw logs -f guest-gateway     # 計測ログ(upload_finished に mbps)
```

公開 URL は `https://<TS_HOSTNAME>.<tailnet>.ts.net`(`docker exec guest_gateway_ts tailscale status` で確認)。
**URL・tailnet 名はリポジトリや報告に書かない。**

### 計測で見るもの

- `upload_finished` ログの `size` / `elapsedMs` / `mbps` / `detectedType`(iPhone の HEIC/JPEG・動画形式の確認)
- 画面の「計測情報」: サーバーから見える接続元 IP と、Funnel 経由かどうか
- iPhone の形式確認でファイル自体を残したい場合だけ、`.env` を `KEEP_UPLOADS=true` にして再起動。
  受信済みファイルは `/mnt/photo/guest-gateway/staging/kept/<id>.<拡張子>` に移され、
  期限切れ掃除の対象外になる(受付期限 `CLOSES_AT` を過ぎた時点のステージング一括削除で消える)。
  確認後は false に戻し、`kept/` を削除する

### 停止

```bash
docker compose -p wedding-gw down
```

⚠️ ミニPC本体で `tailscale funnel reset` / `tailscale serve reset` は使わない(Immich の tailnet 公開も消える)。
