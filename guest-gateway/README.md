# guest-gateway

イベントのゲスト(Immich アカウントも Tailscale も無い人)が、リンク + 合言葉だけで
写真・動画をアップロードできる窓口。設計と運用は [docs/guest-gateway.md](../docs/guest-gateway.md)、
実装ルールは [.claude/rules/guest-gateway.md](../.claude/rules/guest-gateway.md)。

> **現在の到達点**: ニックネーム + 合言葉でログイン → tus で受信 → 中身を判定 → 取り込みキューで
> Immich のアルバムへ追加(`IMMICH_SHARE_KEY` 未設定なら受信して削除するだけの速度検証モード)。
> 閲覧・削除はまだ無い。

## 構成

| パス                                   | 内容                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/index.js`                         | 起動・定期処理(期限切れアップロードの掃除、受付終了時のステージング削除)            |
| `src/app.js`                           | ルート定義(ここに無いものは 404)、セキュリティヘッダー、CSRF 対策、期限切れ時の 410 |
| `src/auth.js`                          | 合言葉の scrypt 照合、HMAC 署名付きセッション Cookie、ニックネームの正規化          |
| `src/uploads.js`                       | tus 受信(拡張子・サイズ・空き容量の検査、中身の判定、計測ログ)→ 取り込み待ちへ移動  |
| `src/importer.js`                      | 取り込みキュー(Immich へ送信・再試行・結果の記録・ステージング削除)                 |
| `src/store.js`                         | 受信ファイルと取り込み結果の記録(`node:sqlite`、`DB_PATH`)                          |
| `src/immich.js`                        | Immich v3 の呼び出し(共有リンクキーでアップロード・一覧、削除専用キーで削除)        |
| `scripts/setup-event.js`               | イベント用の Immich 準備(専用ユーザー・アルバム・共有リンク・削除専用キー)を自動化  |
| `dev/compose.yml`                      | 開発用 Immich v3.2.4(Mac のローカル専用)                                            |
| `public/`                              | ゲスト用画面(ビルド工程なし)                                                        |
| `compose.yml` / `ts-config/serve.json` | Tailscale サイドカー(Funnel で 443 公開)+ 窓口                                      |

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

開発用 Immich へ実際に取り込む場合は、`scripts/setup-event.js` の出力ファイルを読み込み、
`IMMICH_URL=http://127.0.0.1:2283 DB_PATH=../tmp/dev-gateway.db` を足して起動する
(例: `set -a && . ../tmp/dev-immich/event1.env && set +a` の後に上のコマンド)。

### 開発用 Immich(結合テスト用)

```bash
docker compose -f dev/compose.yml up -d     # 127.0.0.1:2283
# 結合テスト(初回は開発用の管理者も自動で作る。値は開発用のダミー)
IMMICH_IT_URL=http://127.0.0.1:2283 IMMICH_IT_ADMIN_EMAIL=admin@example.com \
IMMICH_IT_ADMIN_PASSWORD=dev-admin-password-123 npm test
docker compose -f dev/compose.yml down      # 停止(データは残る)
```

データの置き場所: 写真ライブラリは `../tmp/dev-immich/`、Postgres のデータは名前付き Docker ボリューム
`dev-pgdata`(`tmp/` を消しても残る)。開発用 Immich を完全に初期化するときだけ:

```bash
docker compose -f dev/compose.yml down -v   # ⚠️ 開発用 DB(ボリューム dev-pgdata)を削除する。開発用のみ
rm -rf ../tmp/dev-immich                    # ライブラリも消す場合
```

確認済みの Immich v3.2.4 の挙動(結合テストで検証): 共有リンク経由のアップロードは重複も含めて
アルバムに自動追加される / 一覧は `nextCursor` で次ページ / **新形式の検索はゴミ箱の写真も返すため
`trashedAt: {eq: null}` が必要** / 削除専用キーで削除するとゴミ箱へ移り一覧から消える。

## イベント用の Immich 準備(本番)

`scripts/setup-event.js` が、結婚式専用ユーザー → アルバム(管理者を編集者として招待)→
共有リンク(アップロード/ダウンロード許可・期限付き・パスワードなし)→ 削除専用 API キーを作り、
秘密情報を権限 600 のファイルにだけ書き出す。ミニPCには Node が無いので窓口のイメージで実行する:

```bash
docker build -t guest-gateway /srv/photosaver/repo/guest-gateway
read -rs IMMICH_ADMIN_PASSWORD && export IMMICH_ADMIN_PASSWORD
docker run --rm --network photosaver_gw -v /srv/photosaver/guest-gateway:/out \
  -e IMMICH_URL=http://immich-server:2283 -e IMMICH_ADMIN_EMAIL=<管理者メール> -e IMMICH_ADMIN_PASSWORD \
  guest-gateway node scripts/setup-event.js --name '<アルバム名>' --event-email <専用ユーザーのメール> \
  --expires 2026-10-31T23:59:00+09:00 --out /out/immich.env
unset IMMICH_ADMIN_PASSWORD
```

- `--expires` は `Z` か `+09:00` のような時差付きの完全な日時で、未来であること(違えば Immich に触る前に中止)
- 出力ファイルは最初に確保する。既にある・ディレクトリが無い・書き込めない場合は Immich に触る前に中止し、
  途中で失敗したら出力ファイルは削除される
- Immich が 3.2.4 未満なら中止する(SVG 経由の脆弱性の修正版が必要)
- 途中で失敗した場合、作成済みの専用ユーザーが残る。Immich の管理画面で削除してからやり直す
- 専用ユーザーのパスワードはどこにも保存・表示しない(`immich.env` にはメールアドレスだけ)。
  その専用ユーザーでログインする必要が出たら、Immich の管理画面でパスワードをリセットする
- `immich.env` の値(共有リンクキー・削除キー)は表示・コミットしない(`guest-gateway/.gitignore` で `*.env` を除外済み)
- コンテナは uid 1000(node)で動き、書き出した `immich.env` は uid 1000 の権限 600 になる。compose を
  実行するミニPCのユーザーも uid 1000 であること(`id -u` が 1000。Ubuntu の最初のユーザーは通常そう)。
  違う場合はここで止めて相談する
- 削除キーの影響範囲: Immich の `asset.delete` 権限は `force: true` の完全削除や `POST /trash/empty` も
  許すため、漏れると専用ユーザーが所有する全写真・動画を完全に消せる(窓口自身は `force` を送らない)

## デプロイ(ミニPC / 自宅PCから SSH で実施)

前提:
- Tailscale 管理画面の設定(`tag:wedding-gw` と funnel の許可)と認証キーの発行が済んでいること
  ([docs/guest-gateway.md](../docs/guest-gateway.md) の準備手順 2)
- Immich 本体が内部ネットワーク `photosaver_gw` 付きの compose で起動していること
  (`docker network inspect photosaver_gw` が成功する。未反映なら
  [docs/operations.md](../docs/operations.md) の「compose 設定の反映」)。窓口はこのネットワーク経由で
  `immich-server:2283` だけに届く

`immich.env` が無い状態で起動すると**速度検証モード**(受信して削除するだけ)。イベント用に取り込むには
下の「取り込みモードに切り替える」を行う。

```bash
# 1. コードを更新
git -C /srv/photosaver/repo pull --ff-only

# 2. ディレクトリ(ステージングは写真 HDD 上)
#    HDD が外れていると /mnt/photo は空のシステムディスク上のディレクトリになり、mkdir すると
#    そこに書き込まれてしまう。HDD 上にだけあるマーカーで確認してから作る
#    ('HDD not mounted' と出たらここで中止し、HDD のマウントを先に直す)
if test -f /mnt/photo/.photosaver.mount-ok; then
  mkdir -p /srv/photosaver/guest-gateway/db /mnt/photo/guest-gateway/staging
  # コンテナは uid 1000 (node) で動く。db/ は取り込みの記録(NVMe)
  sudo chown 1000:1000 /mnt/photo/guest-gateway/staging /srv/photosaver/guest-gateway/db
else
  echo 'HDD not mounted'
fi
#    窓口コンテナにもこのマーカーを読み取り専用で渡す(無ければ起動しない・受付も止める)

# 3. .env を作る(権限 600。値は表示・コミットしない)
#    既にある .env(Tailscale 認証キーを書き込み済みなど)は上書きしない
[ -f /srv/photosaver/guest-gateway/.env ] || \
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

### 取り込みモードに切り替える

1. 「イベント用の Immich 準備(本番)」で `scripts/setup-event.js` を実行し、
   `--out /out/immich.env`(= ホストの `/srv/photosaver/guest-gateway/immich.env`、権限 600)に書き出す。
   `--expires` は `CLOSES_AT` より後(余裕を持たせる)にする
2. 窓口を作り直す(`immich.env` を読み込ませる):
   ```bash
   docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml \
     --env-file /srv/photosaver/guest-gateway/.env up -d --build --force-recreate guest-gateway
   docker compose -p wedding-gw logs --tail 20 guest-gateway   # immich_ok(version 3.2.4 以上)を確認
   ```
3. スマホから1枚上げ、画面に「アルバムに追加しました」と出て、Immich のアルバムに入ることを確認する

ログの見方: `import_done`(取り込み成功)、`import_retry`(Immich 側の一時的な失敗、自動で再試行)、
`import_failed`(諦めた。Immich が拒否した or 再試行上限)。窓口を再起動しても取り込み待ちの分は続きから再開する。
