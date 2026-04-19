# Tailscale によるリモートアクセス

HPSS / Photosaver の**外部アクセスは Tailscale で行う**。Immich 公式ドキュメントも推奨する方式で、ドメイン不要・完全無料(3 ユーザー + 100 デバイスまで)・クレジットカード不要。

## アーキテクチャ

```
[スマホ / PC (Tailscale client)]
         ↓ Tailscale の WireGuard メッシュ VPN
[家の Windows PC(Tailscale installed)]
         ↓ tailscale serve — HTTPS 終端 + localhost:3000 へ転送
[Docker: album-guard :3000]
         ↓ HTTP passthrough
[Docker: immich-server :2283]
         ↓ bind mount
[外付けドライブ E:\Photo]
```

**アクセス URL の形**: `https://<hostname>.<tailnet-name>.ts.net`
(例: `https://photosaver.tail12345.ts.net`)

**到達可能な端末**:
- あなた自身の Tailscale 認証済の PC・スマホ
- あなたが tailnet に招待した家族・友人の端末(Tailscale インストール + ログイン必須)

Tailscale 未インストール端末からは**URL も IP も見えず、到達不能**(パブリック URL ではないため)。

---

## セットアップ手順

### Stage 1: Tailscale アカウント + Windows クライアント(5 分)

1. [https://tailscale.com/download/windows](https://tailscale.com/download/windows) にアクセス → Windows 版ダウンロード
2. インストーラーを実行
3. 初回起動 → ブラウザで Google / GitHub / Microsoft アカウントでログイン
4. タスクトレイに Tailscale アイコン(✓)が表示されれば接続完了
5. 右クリック → **Admin console** を開いて自分の tailnet が作成されたことを確認

**無料プラン制限**:
- 3 ユーザー + 100 デバイス
- ユーザー招待は device sharing で回避可(device 共有は無制限)

### Stage 2: ホスト名を設定して Tailnet に album-guard ホストを登録(2 分)

1. Tailscale タスクトレイ → **Preferences** → **Advanced**
2. Hostname を `photosaver`(任意)に変更 → 再接続
3. Tailscale Admin Console ([https://login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines))で `photosaver` が一覧に表示されることを確認
4. Tailscale が払い出した IP(`100.x.x.x` の形)をメモ

### Stage 3: MagicDNS 有効化(1 分)

1. [Tailscale Admin → DNS](https://login.tailscale.com/admin/dns)
2. **MagicDNS** を **ON**
3. **HTTPS Certificates** を **Enable**(`tailscale serve --https` で自動 TLS を取得するのに必要)
4. tailnet 名(例: `tail12345.ts.net`)が表示される。これは削除せずそのまま使う(名前変更も可能だが URL も変わるので注意)

### Stage 4: Docker スタック起動(1 分)

`tailscale serve` の前提として album-guard が動いている必要があるので先に起動。

```powershell
cd C:\Users\fumiy\Desktop\code\Photosaver\immich
docker compose up -d --build
```

全サービス `healthy` 確認:
```powershell
docker compose ps
curl http://localhost:3000/album-guard/health
```

### Stage 5: Tailscale serve で HTTPS 公開(30 秒)

PowerShell を管理者権限で開き:

```powershell
tailscale serve --bg --https=443 localhost:3000
```

フラグ:
- `--bg` — 永続化(再起動後も自動復元)
- `--https=443` — Tailscale ネットワーク上の 443 番ポートで HTTPS 終端
- `localhost:3000` — 転送先(album-guard)

確認:
```powershell
tailscale serve status
```

出力例:
```
https://photosaver.tail12345.ts.net (tailnet only)
|-- / proxy http://localhost:3000
```

### Stage 6: 動作確認(1 分)

1. スマホ([iOS](https://apps.apple.com/app/tailscale/id1470499037) / [Android](https://play.google.com/store/apps/details?id=com.tailscale.ipn))に Tailscale アプリをインストール
2. 同じアカウントでログイン → tailnet に参加
3. モバイルブラウザで `https://photosaver.tail12345.ts.net` を開く
4. Immich Web UI が表示されれば完了
5. 保護アルバムを開くとパスワード入力画面に遷移(album-guard の認証が効く)

**ポイント**: スマホが自宅 WiFi でも外出先の 4G/5G でも同じ URL で到達可能。Tailscale が家-外の VPN を自動構築する。

### Stage 7: 検証スクリプト

```powershell
node scripts/tailscale-verify.mjs
```

tailscale コマンドで tunnel 状態、serve config、album-guard への到達性を自動チェック。

---

## 家族・友人を招待する

### パターン A: ユーザー招待(tailnet の正メンバーに加える)

1. Admin Console → [Users](https://login.tailscale.com/admin/users) → **Invite users**
2. 招待したい相手のメールアドレスを入力
3. 相手がメールのリンクから参加 → Tailscale インストール → 自動的に tailnet に参加

**無料枠**: 自分を含めて 3 ユーザーまで。超過は Personal Plus プラン(6 ユーザー $5/月)へ。

### パターン B: Device Sharing(ユーザー枠を消費しない)

1. Admin Console → [Machines](https://login.tailscale.com/admin/machines) → `photosaver`
2. **Share node** → 相手のメールアドレスを入力
3. 相手が Tailscale に登録済なら即共有、未登録なら登録後に参加

**ユーザー枠を消費せず**、特定のマシン(Photosaver)だけ共有できる。家族 4〜6 人とも無料枠内で共有可。

---

## セキュリティモデル

- **Tailscale レイヤ**: WireGuard ベースの E2E 暗号化。Tailscale Admin で認証した端末のみ接続可
- **album-guard レイヤ**: 保護アルバム UUID への JWT + bcrypt 認証
- **Immich レイヤ**: Immich 本体の user/password 認証

**3 層防御**。Tailscale に招待した家族でも、album-guard で守った「家族プライベート」アルバムは更にパスワード必須という二重守り可能。

---

## トラブルシューティング

### `tailscale serve` が `certificate` エラーを返す

Stage 3 の **HTTPS Certificates** を有効化していない。Admin → DNS で ON にしてから serve 再実行。

### スマホアプリで `https://photosaver.xxx.ts.net` に繋がらない

- スマホの Tailscale アプリが ON になっているか確認
- 別の VPN アプリが干渉していないか(Tailscale と競合する場合あり)
- `ping photosaver` で IP に到達するか確認(アプリの machines 画面で `photosaver` を tap)

### 家族のスマホから album-guard のパスワード入力画面が出ない

album-guard の認証は Immich 標準の `/albums/<uuid>` ではなく API レベルで効く。現実装(Phase B)ではブラウザ UI で直接 401 が出る場合あり。Phase 11.5 で HTML 自動注入により改善予定(`docs/phase-11.5-design.md`)。

暫定: 保護アルバムは `https://photosaver.xxx.ts.net/album-guard/login?albumId=<UUID>` を直接開き、認証後に Immich の該当アルバム URL に戻る。

### album-guard のヘルスが赤(`docker compose ps` で unhealthy)

Tailscale とは無関係。`docker compose logs album-guard --tail 50` で原因調査。`.claude/agents/docker-debugger` で診断可。

---

## `tailscale funnel` を使うと(参考)

**Funnel** は tailnet 外(完全なパブリック)への露出。今回は使わない(Tailscale 非インストール端末からも見られてしまうため)。

もし将来「ブラウザだけで開ける公開リンク」が必要になったら、以下のように `funnel` を代替:
```powershell
tailscale funnel --bg 443 localhost:3000
```

ただし album-guard の認証のみが唯一の関門になるため、`GUARD_JWT_SECRET` 強度と album-passwords.json 管理が極めて重要になる。**本プロジェクトでは `tailscale serve`(tailnet only)推奨**。

---

## 関連スクリプト

| スクリプト | 用途 |
|---|---|
| `scripts/tailscale-verify.mjs` | tailscale CLI が利用可か + serve config + album-guard 到達性の統合検証 |

設定は基本ワンタイム(`tailscale serve --bg` は永続)。tailnet メンバー管理は Tailscale Admin Console で実施。
