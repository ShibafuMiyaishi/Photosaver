# Cloudflare Tunnel 設定

Photosaver を外部からアクセス可能にするための Cloudflare Tunnel セットアップ手順。**本プロジェクトでは必須**(Immich 公式スマホアプリのアルバムパスワード認証はブラウザ経由を推奨、ブラウザからは常に Cloudflare 経由でアクセスする設計)。

## なぜ Cloudflare Tunnel?

- ルーターのポート開放不要 — インバウンドなし、アウトバウンドのみで外部公開
- 固定 IP 不要 — 動的 IP でも安定
- HTTPS 終端を Cloudflare が担当 — 証明書管理ゼロ
- Cloudflare Access と組み合わせで OAuth/SSO を追加可能(Phase B.2 以降の課題)

## 前提条件(**ユーザー側で事前準備**)

以下を Claude では自動化できないため、先に完了させる:

### 1. Cloudflare アカウント
[https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) で無料アカウントを作成。

### 2. ドメインを Cloudflare に移管
[Cloudflare Dashboard](https://dash.cloudflare.com/) → **Add a site** → ドメイン名入力 → Free プラン → 表示されたネームサーバー 2 つを**ドメインレジストラ側**(お名前.com, Route 53 等)で設定。

伝搬確認:
```bash
dig NS yourdomain.com +short
# Cloudflare の ns1.x.ns.cloudflare.com / ns2.x.ns.cloudflare.com が返れば OK
```

最大 24 時間かかる場合あり。通常は数分〜数時間。

### 3. Zero Trust を有効化
Dashboard → **Zero Trust** アイコン → 初回セットアップ → 無料プラン選択(支払い方法の登録を求められる場合あり、課金されなければ費用は 0)。

### 4. API token を発行(Claude が使う)
[https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → **Create Custom Token**

以下のスコープを付与:

| スコープ | レベル | 対象 |
|---|---|---|
| Account | Cloudflare Tunnel | **Edit** |
| Zone    | DNS                | **Edit** |
| Zone    | Zone               | **Read** |

Zone Resources は **Include > Specific zone > yourdomain.com** に制限することを推奨。

発行後の token 文字列を安全に保管(再表示不可、漏洩したら即 revoke)。

### 5. Account ID を控える
Cloudflare Dashboard の任意のページの右サイドバーに「Account ID」が表示されている。コピー。

## 自動セットアップ実行(Claude が実施)

事前準備が完了したら:

### Step A — `.env` に情報を記入

`.env`(プロジェクトルート):

```bash
CLOUDFLARE_API_TOKEN=<step 4 で発行した token>
CLOUDFLARE_ACCOUNT_ID=<step 5 の Account ID>
CLOUDFLARE_ZONE_NAME=yourdomain.com
CLOUDFLARE_HOSTNAME=photos.yourdomain.com
```

`.env` は **gitignore 済**。トークンは永久にローカルのみ。

### Step B — セットアップスクリプト実行

```bash
node scripts/cloudflare-setup.mjs
```

スクリプトが行うこと(冪等):

1. tunnel `hpss-album-guard` を作成(既存なら再利用)
2. tunnel token を `immich/.env` の `CLOUDFLARE_TUNNEL_TOKEN` に自動書き込み
3. ingress 設定 `{hostname} → http://album-guard:3000` を反映
4. DNS CNAME `{hostname} → {tunnel_id}.cfargotunnel.com`(proxied)を作成/更新

### Step C — スタック起動(Cloudflare プロファイル込)

```bash
cd immich
docker compose --profile public up -d --build
```

`cloudflared` サービスが追加起動する。

### Step D — 検証

```bash
node scripts/cloudflare-verify.mjs
```

3 レイヤを検証:
- API で tunnel が active connection を持つか
- DNS が `cfargotunnel.com` を指しているか
- `https://{hostname}/album-guard/health` が 200 + `{status:"ok"}` を返すか

全て ✅ なら Cloudflare Tunnel 完全動作。

## トラブルシューティング

### cloudflared コンテナが起動しない

```bash
docker compose logs cloudflared --tail 50
```

- **token が壊れている** → `scripts/cloudflare-setup.mjs` を再実行
- **インターネット不通** → ホストの ping / DNS を確認

### API から 502 Bad Gateway / 503

- album-guard コンテナが `(healthy)` か確認: `docker compose ps`
- ingress 設定が `album-guard:3000` を指しているか API で確認

### DNS が伝搬しない

- DoH で確認: `curl -H 'Accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=photos.yourdomain.com&type=CNAME'`
- Cloudflare の **Proxied**(オレンジ雲)が有効か Dashboard で確認
- 最大 5 分待つ

### Zero Trust で支払い情報を要求される

- 無料プランでも支払い方法登録は必要(制限超過時に自動停止、本プロジェクト規模では課金にならない)
- 嫌な場合は代替: Tailscale Funnel や ngrok(別アーキテクチャになるので非推奨)

## ローカル専用モード(Cloudflare を使わない)

Cloudflare の設定前や準備中は profile 指定なしで:

```bash
docker compose up -d --build
```

この場合 `cloudflared` は起動せず、アクセスは `http://localhost:3000` のみ。スマホアプリからのアクセスは不可。

## セキュリティ考慮

- **API token**: 高権限。`.env` は絶対コミットしない(`.gitignore` で多重防御)
- **Tunnel token**: immich/.env に自動書き込み。漏洩した場合は Cloudflare Dashboard で tunnel を削除 → `scripts/cloudflare-setup.mjs` で再作成
- **album-guard の JWT 認証が唯一の関門**: Cloudflare Access を未使用なら、`GUARD_JWT_SECRET` の強度と album-passwords の安全な管理がセキュリティ境界
- **将来の強化**: Zero Trust → Access → Applications で `photos.yourdomain.com` に email-OAuth を追加すれば、ブラウザ到達前に OAuth 認証を挟める(アプリからのアクセスは API 経路を分ける必要あり)

## 関連スクリプト

| スクリプト | 用途 |
|---|---|
| `scripts/cloudflare-setup.mjs` | tunnel 作成 + ingress 設定 + DNS CNAME 作成 |
| `scripts/cloudflare-verify.mjs` | 3 レイヤ検証(API / DNS / HTTP E2E) |

設定変更後はいつでも `cloudflare-setup.mjs` を再実行可(冪等動作)。
