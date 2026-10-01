# guest-gateway

イベントのゲスト(Immich のアカウントも Tailscale も無い人)が、**リンク + 合言葉**だけで
写真・動画をひとつの Immich アルバムに上げ、みんなの写真を見て・保存し、自分の投稿を削除できる窓口。
設計と当日の運用は [docs/guest-gateway.md](../docs/guest-gateway.md)、実装ルールは
[.claude/rules/guest-gateway.md](../.claude/rules/guest-gateway.md)。

> **状態(2026-10)**: 機能はすべて実装済み(テストと開発用 Immich で確認)。
> ミニPCへのデプロイ・Funnel の速度計測・スマホ実機での確認は自宅PCで実施する
> ([.claude/handoff/tasks.md](../.claude/handoff/tasks.md) の T1〜T4)。

## できること

- ニックネーム + 合言葉でログイン(幹事は別の**管理者の合言葉**)。期限(`CLOSES_AT`)を過ぎると全機能が止まる
- アップロード: tus で分割・再開可能(画面ロックや回線切替のあとも続きから)。中身を判定して写真・動画だけ受け付け、
  取り込みキューが Immich の共有リンク経由でアルバムに追加する(Immich が止まっていても約 1 日再試行)
- 「みんなの写真」: 一覧・拡大・動画再生・1 件ずつ保存・**まとめて保存**
  (iPhone / iPad → 共有メニューで写真アプリへ、Android → 端末にダウンロード、PC → ZIP)
- 削除: 自分の端末から上げた写真だけ。管理者の合言葉なら全件(Immich のゴミ箱へ移るだけで復元できる)
- `immich.env` が無いときは**速度検証モード**(受信して計測し、削除するだけ)

## 構成

| パス | 内容 |
| --- | --- |
| `src/index.js` | 起動・定期処理(期限切れアップロードの掃除、受付終了時のステージング削除、取り込みの再開) |
| `src/config.js` | 環境変数の読み込みと検証(`IMMICH_SHARE_KEY` が空なら速度検証モード) |
| `src/app.js` | ルート定義(ここに無いものは 404)、セキュリティヘッダー、CSRF 対策、ログイン、期限後の 410 |
| `src/auth.js` / `src/lockout.js` | 合言葉の scrypt 照合と署名付きセッション Cookie / 総当たり対策(接続元ごとのロック) |
| `src/uploads.js` | tus 受信(拡張子・サイズ・空き容量・中身の検査、計測ログ)→ 取り込み待ちへ |
| `src/importer.js` / `src/store.js` | 取り込みキュー(Immich へ送信・再試行) / 受信と取り込み結果の記録(`node:sqlite`) |
| `src/gallery.js` | 一覧(全件集約・重複除去)、画像・動画・原寸の中継、削除、ZIP の分割計画と中継 |
| `src/immich.js` | Immich v3 の呼び出し(共有リンクキー: アップロード・一覧・メディア・ZIP / 削除専用キー: 削除) |
| `src/log.js` | 1 行 1 JSON のログ(秘密情報は出さない) |
| `public/` | ゲスト用画面(ビルド工程なし)。`gallery.js` は「みんなの写真」(PhotoSwipe)、`bulk.js` は端末別の保存 |
| `scripts/setup-event.js` | イベント用の Immich 準備(専用ユーザー・アルバム・共有リンク・削除専用キー)を自動化 |
| `scripts/event-status.js` | 当日の状況確認(件数・容量・期限までの残り・HDD の空き。読み取り専用) |
| `scripts/hash-password.js` | 合言葉のハッシュを作る |
| `compose.yml` / `ts-config/serve.json` | Tailscale サイドカー(専用ノード、Funnel で 443 公開)+ 窓口。プロジェクト名 `wedding-gw` |
| `dev/compose.yml` | 開発用 Immich v3.2.4(開発機のローカル専用。本番には使わない) |

## 開発(自宅PC / Mac)

開発機(自宅の Windows PC、出張中は Mac)で行う。Docker Desktop と Node 24 が必要。コマンドは bash 用
(Windows では Git Bash で実行する)。

```bash
cd guest-gateway
npm ci
npm test          # Vitest(実アプリを空きポートで起動し、ログイン〜アップロード〜ギャラリー・削除・ZIP まで)
npm run lint
```

ローカルで画面を触る場合(速度検証モード):

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

### 確認済みの Immich v3.2.4 の挙動(結合テストと開発用 Immich で検証)

- 共有リンク経由のアップロードは、重複も含めてアルバムに自動追加される
- 一覧は `nextCursor` で次ページ(1 回最大 1000 件)。**新形式の検索はゴミ箱の写真も返すため `trashedAt: {eq: null}` が必要**
- **撮影日時は秒単位で、ページ送りは件数オフセット方式**のため、同じ秒の写真があるとページの境目で重複・欠落が起きる
  (窓口で全件集約して補正)
- 削除専用キーで削除するとゴミ箱へ移り、一覧から消える。ゴミ箱の写真を上げ直すと「重複」になりアルバムには戻らない
- サムネイル・原寸・動画はリダイレクトなしで返り、Range 指定で 206。上げた直後はサムネイル生成待ちで一時的に 404。
  アルバム外の写真は 400
- ZIP は共有リンクで作れる(無圧縮)。ゴミ箱の写真が 1 枚でも混じると ZIP 全体が 400 になるため、
  窓口はダウンロード時点のアルバムで絞る

## デプロイ(ミニPC / 自宅PCから SSH で実施)

前提:

- Tailscale 管理画面の設定(`tag:wedding-gw` と funnel の許可)と認証キーの発行が済んでいること
  ([docs/guest-gateway.md](../docs/guest-gateway.md) の準備手順 2)
- Immich 本体が内部ネットワーク `photosaver_gw` 付きの compose で起動していること
  (`docker network inspect photosaver_gw` が成功する。未反映なら
  [docs/operations.md](../docs/operations.md) の「compose 設定の反映」)。窓口はこのネットワーク経由で
  `immich-server:2283` だけに届く
- 写真 HDD 直下のマーカー `/mnt/photo/.photosaver.mount-ok` があること(窓口が確認する。Immich の
  mount-guard が確認する `immich-library` 内のマーカーとは別。[docs/new-server-setup.md](../docs/new-server-setup.md))

この時点では `immich.env` が無いので**速度検証モード**で動く。イベント用に取り込むには、下の
「取り込みモードに切り替える」を行う。

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
#    (任意)ADMIN_PASSWORD_HASH = 幹事用の合言葉(ゲストとは別)。この合言葉で入るとどの写真も削除できる
#    CLOSES_AT は余裕を持たせる(後から延ばすと全員の再ログインが必要。docs/guest-gateway.md「困ったとき」)
openssl rand -hex 32                                         # → SESSION_SECRET
docker build -t guest-gateway /srv/photosaver/repo/guest-gateway
read -rs P && printf '%s' "$P" | docker run --rm -i guest-gateway node scripts/hash-password.js; unset P
#                                                            # → GUEST_PASSWORD_HASH
#                                         (もう一度、幹事用の合言葉で実行 → ADMIN_PASSWORD_HASH)

# 4. 起動
docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml \
  --env-file /srv/photosaver/guest-gateway/.env up -d --build
docker compose -p wedding-gw ps
docker compose -p wedding-gw logs -f guest-gateway     # 計測ログ(upload_finished に mbps)
```

公開 URL は `https://<TS_HOSTNAME>.<tailnet>.ts.net`(`docker exec guest_gateway_ts tailscale funnel status` で確認)。
**URL・tailnet 名はリポジトリや報告に書かない。**

### 速度検証で見るもの

- `upload_finished` ログの `size` / `elapsedMs` / `mbps` / `detectedType`(iPhone の HEIC/JPEG・動画形式の確認)
- 画面の「計測情報」: サーバーから見える接続元 IP と、Funnel 経由かどうか
- iPhone の形式確認でファイル自体を残したい場合だけ、`.env` を `KEEP_UPLOADS=true` にして再起動。
  受信済みファイルは `/mnt/photo/guest-gateway/staging/kept/<id>.<拡張子>` に移され、
  期限切れ掃除の対象外になる(受付期限 `CLOSES_AT` を過ぎた時点のステージング一括削除で消える)。
  確認後は false に戻し、`kept/` を削除する

## 取り込みモードに切り替える(イベントの準備)

### 1. イベント用の Immich 準備

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

- `--expires`(共有リンクの期限)は `CLOSES_AT` より後(余裕を持たせる)。`Z` か `+09:00` のような時差付きの
  完全な日時で、未来であること(違えば Immich に触る前に中止)
- 出力ファイルは最初に確保する。既にある・ディレクトリが無い・書き込めない場合は Immich に触る前に中止し、
  途中で失敗したら出力ファイルは削除される
- Immich が 3.2.4 未満なら中止する(SVG 経由の脆弱性の修正版が必要)
- 途中で失敗した場合、作成済みの専用ユーザーが残る。Immich の管理画面で削除してからやり直す
- 専用ユーザーのパスワードはどこにも保存・表示しない(`immich.env` にはメールアドレスをコメントで残すだけ)。
  その専用ユーザーでログインする必要が出たら、Immich の管理画面でパスワードをリセットする
- `immich.env` の値(共有リンクキー・削除キー)は表示・コミットしない(`guest-gateway/.gitignore` で `*.env` を除外済み)
- コンテナは uid 1000(node)で動き、書き出した `immich.env` は uid 1000 の権限 600 になる。compose を
  実行するミニPCのユーザーも uid 1000 であること(`id -u` が 1000。Ubuntu の最初のユーザーは通常そう)。
  違う場合はここで止めて相談する
- 削除キーの影響範囲: Immich の `asset.delete` 権限は `force: true` の完全削除や `POST /trash/empty` も
  許すため、漏れると専用ユーザーが所有する全写真・動画を完全に消せる(窓口自身は `force` を送らない)

### 2. 窓口を作り直して確認

```bash
docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml \
  --env-file /srv/photosaver/guest-gateway/.env up -d --build --no-deps --force-recreate guest-gateway
docker compose -p wedding-gw logs --tail 20 guest-gateway   # immich_ok(version 3.2.4 以上)を確認
```

スマホから 1 枚上げ、画面に「アルバムに追加しました」と出て、Immich のアルバムに入ることを確認する。

ログの見方: `import_done`(取り込み成功)、`import_retry`(Immich 側の一時的な失敗、自動で再試行)、
`import_failed`(諦めた。Immich が拒否した or 約 1 日の再試行上限)。窓口を再起動しても取り込み待ちの分は続きから再開する。
件数の確認は `docker exec guest_gateway node scripts/event-status.js`(読み取り専用。件数・容量・期限までの残り・
HDD の空きを表示し、取り込みの詰まりや失敗があれば ⚠️ を出す)。当日の手順は
[docs/guest-gateway.md](../docs/guest-gateway.md#当日の運用)。

## 停止

```bash
docker compose -p wedding-gw down
```

⚠️ ミニPC本体で `tailscale funnel reset` / `tailscale serve reset` は使わない(Immich の tailnet 公開も消える)。
