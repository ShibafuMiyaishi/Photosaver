# ゲスト用アップロード窓口(guest-gateway)

> **状態: 開発中(2026-10)**。最初の利用は友達の結婚式。現在はアップロード → アルバムへの取り込みまで実装済み
> (閲覧・削除は未実装)。コードと手順: [guest-gateway/](../guest-gateway/README.md)
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

## 当日の運用(予定)

- 案内カード: QR コード + 合言葉 + 注意書き
  - 「アップロード中は画面を開いたまま」
  - 「たくさんある場合は10枚ずつ」
  - 「iPhone は写真選択画面の『オプション → フォーマット → 現在』がおすすめ」
- HDD の空き容量を時々確認
- **緊急停止**: `docker compose -p wedding-gw down`
  (⚠️ `tailscale funnel reset` / `tailscale serve reset` は使わない。ミニPC本体で実行すると Immich の tailnet 公開まで消える)

## 終了後の後片付け(予定)

1. 期限で窓口は自動終了。確認後 `docker compose -p wedding-gw down`
2. Tailscale 管理画面: 窓口ノードの削除、認証キーの失効、`nodeAttrs` の funnel 行を削除
3. Immich: 共有リンクを削除(アルバムと写真は残す)。API キーを削除
4. ゲストには「残したい写真は期限までに保存」と事前に周知しておく
