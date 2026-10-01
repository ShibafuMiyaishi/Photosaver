# ゲスト用アップロード窓口(guest-gateway)

> **状態: 開発中(2026-10)**。最初の利用は友達の結婚式。現在はアップロード → アルバムへの取り込み、
> 「みんなの写真」での閲覧・保存、削除(自分の投稿のみ・管理者は全件)、当日の手順書まで用意済み(実機での確認は自宅PCで実施)。コードと手順: [guest-gateway/](../guest-gateway/README.md)
> 本ページは設計と運用手順のまとめ。実装の詳細ルールは `.claude/rules/guest-gateway.md`。

## 何をするものか

Immich のアカウントも Tailscale も持っていない**イベントのゲスト**が、
**リンク + 合言葉**だけで次のことをできるようにする小さな Web アプリ。

- 指定したアルバムに**写真・動画を直接アップロード**(Immich 側でアルバムに自動追加される)
- アルバム全体を閲覧・保存(単品保存。ZIP 一括は余裕があれば)
- 初回にニックネームを入力 → 誰が上げたかを記録
- 自分の端末で上げた写真は自分で削除できる。**管理者の合言葉**で入ると全件削除可能
- 期限を過ぎると自動で閉じる(ログイン・アップロード・閲覧すべて停止)

容量上限は設けない(結婚式専用ユーザーのクォータは無制限)。

## なぜ自作か(2026-10 調査)

| 候補 | 判断 |
|---|---|
| Immich 標準の共有リンク | アップロード許可・期限は可能。ただし Immich 本体を公開する必要があり、投稿者名・ゲスト削除は無い。共有リンクのパスワードは入口画面でしか効かない |
| Immich Public Proxy | 読み取り専用(アップロード非対応は作者の方針) |
| immich-drop(本家) | Immich v3 非対応・メンテ停止、大きな動画をメモリに全読み込み |
| ttlequals0/immich-drop | v3 対応だが閲覧・削除・ニックネーム無し、メモリ全読み込み |

→ 先行事例の良い設計(想定外は 404、共有キーでのアップロード、ストリーミング中継)を取り入れて自作する。

## 構成

```
ゲストのスマホ(ブラウザ)
  │ https://<窓口ノード名>.<tailnet>.ts.net   ← Tailscale Funnel(公開はここだけ)
  ▼
[Tailscale 専用ノード(コンテナ)] tag:wedding-gw
  ▼
[guest-gateway] Node 24 ─ 合言葉の確認、tus で分割アップロード受信、決めた操作だけ中継
  ▼  内部ネットワーク photosaver_gw(immich-server だけが参加。Redis・Postgres には届かない)
[Immich] ← 今まで通り tailnet 内だけ(ミニPC本体の 443 serve は触らない)
```

- 窓口と Immich をつなぐ `photosaver_gw` は、Immich 本体の compose(`server/docker-compose.yml`)が作る
  外部への出口のない内部ネットワーク。窓口が乗っ取られても、Immich 一式の中で届くのは
  immich-server の API だけ(Redis・Postgres には届かない)。窓口自体は Tailscale のために
  インターネットへは出られる

- ミニPC本体とは**別の Tailscale ノード**として公開する。URL にポート番号が付かず、
  ミニPC(Immich)のホスト名も出ない
- compose は `server/` とは別プロジェクト(`-p wedding-gw`)。止めるときは1コマンド
- アップロードは **tus(分割・再開可能)**。iPhone は画面ロックで通信が止まるため、
  続きから再開できることが必須

## 認証情報(すべてミニPCの `.env` のみ。リポジトリには置かない)

| 認証情報 | 用途 | 漏れたときの範囲 |
|---|---|---|
| 結婚式専用 Immich ユーザーの**アルバム共有リンクのキー**(アップロード許可・期限付き) | アップロード・一覧・表示・保存 | そのアルバムだけ |
| 同ユーザーの API キー(権限 `asset.delete` のみ) | ゲスト・管理者の削除(ゴミ箱行き、復元可) | 結婚式専用ユーザーの写真だけ |
| ゲスト合言葉・管理者合言葉(ハッシュ)、Cookie 署名鍵 | ログイン | — |
| Tailscale 認証キー(`tag:wedding-gw`) | 専用ノードの参加 | — |

- 共有リンクは**結婚式専用ユーザー自身**が作る(削除できるのは所有者だけで、
  共有リンク経由の写真はリンク作成者の所有になるため)。自分のアカウントはアルバムに編集者として招待する
- **Immich は v3.2.4 以上が必須**(SVG 経由の重大な脆弱性 GHSA-q89f-h332-8q2h の修正版)

## 準備手順

作業は自宅PC(ミニPCに SSH できるマシン)で行う。Claude Code に任せる場合は
`.claude/handoff/tasks.md` を読ませる。

### 1. 事前確認(読み取りのみ)

Immich のバージョン、docker ネットワーク(`photosaver_gw` が反映済みか)、Tailscale のバージョン、
HDD の空き、マウント確認用マーカーの位置を確認する。詳細は `tasks.md` の T1。

### 2. Tailscale 管理画面

1. **Access controls** に追記(既存のルールは変えない):
   ```jsonc
   "tagOwners": { "tag:wedding-gw": ["autogroup:admin"] },
   "nodeAttrs": [ { "target": ["tag:wedding-gw"], "attr": ["funnel"] } ],
   ```
2. **Settings → Keys → Generate auth key**: Reusable オフ / Ephemeral オフ /
   Tags `tag:wedding-gw` / 期限 30 日
3. キーはミニPCの `/srv/photosaver/guest-gateway/.env`(権限 600)にだけ書く

### 3. 速度の事前検証(最重要)

Funnel の帯域上限は非公開のため、**実機で測って採否を決める**。
デプロイ手順は [guest-gateway/README.md](../guest-gateway/README.md#デプロイミニpc--自宅pcから-ssh-で実施)
(Immich の接続情報 `immich.env` を置かなければ、受信して削除するだけの速度検証モードで動く)。

| テスト | 内容 |
|---|---|
| 単発 | モバイル回線(Wi-Fi ではなく)の iPhone / Android から 500MB・1GB・3GB の動画を上げて時間を測る |
| 同時 | 5台で同時にアップロード(可能なら10本) |
| 再開 | 途中で画面ロック、機内モード、Wi-Fi↔モバイル切替 → 続きから再開できるか |
| iPhone の挙動 | HEIC/JPEG の扱い、動画が圧縮されるか、撮影日時 |
| 接続元 IP | 窓口アプリから本当の接続元 IP が見えるか(ログイン試行制限に必要) |
| 停止 | 停止コマンド後、外から窓口に届かず、tailnet 内の Immich は使えるか |

**合格の目安**: モバイル回線で 1GB が 15 分以内、5台同時でもエラーなし。
満たさない場合の代替: 国内 VPS 経由(月1,000円程度)、または Cloudflare Tunnel
(tus の分割で 100MB 制限は回避可能。ただし CLAUDE.md のルール変更が必要)。

## 当日の運用

コマンドはすべてミニPC上(自宅PCから SSH)で実行する。SSH するたびに最初に
`GW=/srv/photosaver/guest-gateway` を実行しておく(以下のコマンドはこの変数を使う)。

設定(`$GW/.env`)を変えたあとの窓口の作り直し(以下「作り直し」)は次のコマンド。当日はイメージを作り直さない
(`--build` を付けない)ので、リポジトリの更新が混ざらず、Tailscale のコンテナも止まらない:

```bash
docker compose -f /srv/photosaver/repo/guest-gateway/compose.yml --env-file $GW/.env \
  up -d --no-deps --force-recreate guest-gateway
```

作り直しの間(数秒)は送信が一時停止するが、ゲストの画面で自動的に再試行される。ログイン中の人はそのまま使える。

### 前日までのチェック

- [ ] `.claude/handoff/tasks.md` の T4(本番準備・スマホでの通し確認)が終わっている
- [ ] `CLOSES_AT` は**余裕を持たせて**設定した(例: 式の1週間後)。後から延ばすと全員の再ログインが必要になる(下の「期限を延ばす」)
- [ ] 共有リンクの期限(`setup-event.js --expires`)が `CLOSES_AT` より後
- [ ] 幹事用の合言葉(`ADMIN_PASSWORD_HASH`)を設定し、幹事に合言葉を伝えた
- [ ] 状況確認(下記)の「HDD の空き」が、目安「ゲスト数 × 5 GB + 10 GB」より十分大きい(Immich 本体も同じ HDD を使う)
- [ ] モバイル回線のスマホでログイン → 1枚上げる → 「みんなの写真」で見える。テスト写真は削除しておく
- [ ] 案内カード(QR コード)を印刷し、自分のスマホで QR を読んで開けることを確認した

### 案内カード

QR コードには**窓口の URL だけ**を入れる(合言葉は入れない。カードに文字で書く)。
URL は `docker exec guest_gateway_ts tailscale funnel status` に表示される `https://….ts.net`。
QR は手元の PC で作る(例: `qrencode -o qr.png '<URL>'`、Mac なら `brew install qrencode`)。
**URL・合言葉・QR 画像はリポジトリや報告に書かない。**

カードの文面(例):

```
📷 写真・動画をみんなで共有しましょう

1. QR コードを読み取る(LINE などのアプリ内で開いたら「ブラウザで開く」を選んでください)
2. ニックネームと、合言葉「(合言葉)」を入力
3. 「写真・動画を選ぶ」で選ぶと、送信が始まります

・送信中は画面を開いたままにしてください
  (閉じてしまった場合は、開き直して同じ写真をもう一度選ぶと続きから送れます)
・たくさんある場合は 10 枚ずつがおすすめです(1 ファイル 4 GB まで)
・iPhone は写真を選ぶ画面の「オプション → フォーマット → 現在」がおすすめです
・「みんなの写真」から、全員の写真を見たり保存したりできます
・自分が送った写真は、同じスマホ・同じブラウザから削除できます
・(締切の日時)まで利用できます。残したい写真はそれまでに保存してください
```

(iPhone の「オプション → フォーマット」の表記は T4 の実機確認で確かめてから印刷する)

### 当日の監視

```bash
docker exec guest_gateway node scripts/event-status.js   # 件数・容量・期限までの残り・HDD の空き
docker compose -p wedding-gw logs --since 30m guest-gateway \
  | grep -E 'import_retry|import_failed|import_file_missing|staging_dir_unavailable|login_locked|login_global_pause|upload_rejected'
```

- `event-status.js` は件数だけを表示する(ニックネーム・ファイル名は出さない)。⚠️ が出たら、表示どおりログを確認する
- `import_retry` が続く(取り込み待ちが減らない): Immich 本体を確認する(`docker compose -p photosaver ps`)。
  窓口は受信済みのファイルを保持し、Immich が戻れば自動で取り込みを再開する(約1日は再試行を続ける)
- `import_failed`: Immich がファイルを拒否した、または約1日再試行しても届かなかった。受信したファイルは削除済みなので、
  その人に送り直してもらう
- `upload_rejected_disk_full`: HDD の空きが「ファイルサイズ + `MIN_FREE_GB`(既定 10 GB)」に足りないファイルを断っている
  (小さいファイルはまだ通ることがある)。不要なファイルを消して空きを作る。`MIN_FREE_GB` を下げるのは、Immich 本体の
  空きも残る場合だけ
- `upload_rejected_mount_marker_missing` / `staging_dir_unavailable`: HDD が外れている。HDD を確認する
  (窓口は受信ファイルをシステムディスクに書かず、受付を止める)

### よくある問い合わせ

| 症状 | 対応 |
|---|---|
| LINE・Instagram などのアプリ内で開いて、うまく動かない | 右上のメニューから「ブラウザで開く」(Safari / Chrome)で開き直す |
| 送信が止まった・進まない | 画面を開き直し、同じ写真をもう一度選ぶ → 送信済みの分の続きから再開する。電波の良い場所で |
| 合言葉を何度か間違えて入れなくなった | 同じ接続元から 15 分で 5 回失敗すると 15 分ロック(繰り返すと長くなり、最長 24 時間)。Wi-Fi ⇄ モバイル回線を切り替えると別の接続元になる。会場 Wi-Fi で多数が巻き込まれた場合は「作り直し」(ロックはメモリ上なので解除される) |
| 誰も入れない(`login_global_pause`) | 全体で失敗が 100 回を超えると、総当たり対策で 5 分間すべてのログインを止める。5 分待つ。続くなら合言葉が想定外に広まっていないか確認する |
| 削除ボタンが出ない | 削除できるのは**同じスマホ・同じブラウザ**から送り、新しくアルバムに入った写真だけ(別のブラウザ・プライベートブラウズ・Cookie 削除・再ログイン後や、既にアルバムにあった写真の重複は不可)。幹事が管理者の合言葉で入って消す |
| 「同じ写真が既にアルバムにあります」 | 正常。既に入っているので、もう一度送らなくてよい |
| 「みんなの写真」に出てこない | 送信直後はアルバムへの追加とサムネイル作成に少し時間がかかる。少し待って「更新」を押す |

### 幹事の操作

- 幹事は**管理者の合言葉**(`ADMIN_PASSWORD_HASH`)で入ると、不適切な写真などを誰の投稿でも削除できる
- **誤って消した写真の戻し方**: 削除は完全削除ではなく、結婚式専用ユーザーのゴミ箱へ移るだけ(Immich の既定では
  30 日後に自動で完全削除)。Immich の管理画面でその専用ユーザーのパスワードをリセットしてログインし、
  ゴミ箱から復元する。復元すると、投稿者の表示と本人の削除権限も元に戻る

### 困ったとき

- **外から窓口に届かない**: `docker compose -p wedding-gw ps`(2つとも動いているか)、
  `docker exec guest_gateway_ts tailscale funnel status`(Funnel が有効か)、`docker compose -p wedding-gw logs --tail 50 ts`、
  Tailscale 管理画面の Machines で窓口ノードがオンラインか(認証キーの期限切れ・ノードの期限切れ)を確認する。
  tailnet 内の Immich は影響を受けない
- **ミニPCが再起動した**: Immich と窓口は自動で起動する。ただし HDD がマウントされていないと窓口は起動しない
  (システムディスクに書き込まないため)。`test -f /mnt/photo/.photosaver.mount-ok && echo ok` で HDD を確認し、
  `docker compose -p wedding-gw ps` で窓口が止まっていれば「作り直し」、最後に `event-status.js` で取り込み待ちが減っていくことを確認する
- **期限を延ばす(期限を間違えて既に閉じてしまった場合も同じ)**: `$GW/.env` の `CLOSES_AT` を書き換えて「作り直し」。
  ログイン済みの人の Cookie は元の期限で切れるため、その時点で全員の再ログインが必要になり、それ以前に送った写真は
  本人が削除できなくなる(幹事は削除できる)。既に閉じていた場合、受信途中だったファイルは消えているが、取り込み待ちの分は
  残っている。共有リンクの期限も新しい `CLOSES_AT` より後である必要がある(足りなければ専用ユーザーで Immich にログインし、
  共有リンクの期限を延ばす)。**できるだけ最初から余裕のある期限にしておく**
- **合言葉が想定外に広まった**: 新しい合言葉のハッシュを作り(`.env.example` の手順。ミニPCではイメージ経由で
  `scripts/hash-password.js` を実行)、`GUEST_PASSWORD_HASH` を差し替えて「作り直し」。新しくログインする人だけが新しい
  合言葉を必要とし、ログイン済みの人はそのまま使える。ログイン済みの人も全員追い出す場合は `SESSION_SECRET` も作り直す
  (全員が再ログインになり、それまでの写真は本人が削除できなくなる)
- **緊急停止**: `docker compose -p wedding-gw down`(外から窓口に届かなくなる。tailnet 内の Immich はそのまま使える)。
  受信済みの記録(`$GW/db`)とステージングは残るので、デプロイ手順の「起動」で再開すれば取り込み待ちの分から続く
  (⚠️ `tailscale funnel reset` / `tailscale serve reset` は使わない。ミニPC本体で実行すると Immich の tailnet 公開まで消える)

## 終了後の後片付け

1. 期限を過ぎると窓口は自動で閉じる(ログイン・アップロード・閲覧すべて停止し、受信途中のファイルは削除される。
   受信済みで取り込み待ちの分は取り込みを続ける)。
   `docker exec guest_gateway node scripts/event-status.js` で取り込み待ちが 0 件になったこと(失敗の件数も)を確認してから
   `docker compose -p wedding-gw down`
2. Tailscale 管理画面: 窓口ノード(`tag:wedding-gw`)を削除、認証キーを失効、`nodeAttrs` の funnel 行を削除
3. Immich: 共有リンクを削除(アルバムと写真は残す)。削除用の API キーを削除
4. ミニPC(次のイベントでは `setup-event.js` からやり直す):
   ```bash
   rm -f /srv/photosaver/guest-gateway/immich.env              # 共有リンクのキーなど
   rm -f /srv/photosaver/guest-gateway/db/gateway.db*          # ニックネームの記録(ディレクトリは残す)
   sudo rm -r /srv/photosaver/guest-gateway/ts-state           # 窓口ノードの Tailscale 状態
   sudo rm -r /mnt/photo/guest-gateway/staging/*               # ステージングの残り(中身だけ)
   ```
   `/srv/photosaver/guest-gateway/.env` の `TS_AUTHKEY` は空にする。記録を消したあとは、ゴミ箱から復元しても投稿者の表示は戻らない
5. ゲストには「残したい写真は期限までに保存」と事前に周知しておく(期限後は窓口から見られない)
