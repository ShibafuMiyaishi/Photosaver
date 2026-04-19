# Cloudflare Tunnel 設定

外部からアクセス可能にするための Cloudflare Tunnel セットアップ手順。**MVP では必須ではない**(ローカル専用でも動作する)。

## なぜ Cloudflare Tunnel?

- 自宅ルーターのポート開放不要(セキュリティ向上)
- 固定 IP 不要(動的 IP でも OK)
- HTTPS 終端を Cloudflare が担当(証明書管理不要)
- Cloudflare Access と組み合わせると、ブラウザアクセスに OAuth/SSO を追加可能

## 前提

- Cloudflare アカウント(無料プラン OK)
- 自分のドメイン(例: `yourdomain.com`)を Cloudflare に移管済み
- Zero Trust のサブスクリプション(無料枠あり)

## セットアップ手順

### 1. トンネル作成

1. Cloudflare Dashboard → Zero Trust → Networks → Tunnels
2. **Create a tunnel** → 種類は **Cloudflared**
3. トンネル名を入力(例: `homeserver`)
4. トークンが表示されるのでコピー(`eyJhIj...` で始まる長い文字列)

### 2. トークンを環境変数に設定

`immich/.env`:
```bash
CLOUDFLARE_TUNNEL_TOKEN=eyJhIj...<長い文字列>
```

### 3. Public Hostname 設定

Tunnel 画面 → **Public Hostname** タブ → **Add a public hostname**

| 項目 | 値 |
|---|---|
| Subdomain | `photos`(任意) |
| Domain | `yourdomain.com` |
| Path | (空) |
| Service Type | `HTTP` |
| URL | `album-guard:3000` ← **immich-server ではなく album-guard を指定** |

**重要**: Phase 11 以降は必ず `album-guard:3000` に設定する。`immich-server:2283` を直接指定するとアルバムパスワード保護が効かない(仕様書 11.5.2 参照)。

### 4. (オプション)Cloudflare Access で OAuth 追加

Zero Trust → Access → Applications → Add an application

- **Self-hosted Application** として `photos.yourdomain.com` を登録
- ポリシー例: `Emails ending in: @yourdomain.com`

これにより、**ブラウザアクセスに Google/GitHub ログインを追加可能**。ただし API には効かないため、Immich スマホアプリは別ルート(または Access 無効化)が必要。

## 動作確認

1. スタック起動:
   ```powershell
   cd immich
   docker compose up -d cloudflared
   ```
2. Cloudflare Dashboard で Tunnel のステータスが **Healthy**
3. ブラウザで `https://photos.yourdomain.com/album-guard/health` → `{"status":"ok"}`
4. Immich Web UI が表示される

## トラブルシューティング

### cloudflared が起動しない
- `CLOUDFLARE_TUNNEL_TOKEN` の値が正しいか(改行混入に注意)
- `docker compose logs cloudflared` で詳細確認
- トークンが失効していないか Dashboard で確認

### 502 Bad Gateway
- Public Hostname の Service URL が `album-guard:3000` になっているか
- album-guard コンテナが `healthy` か
- 両者が同じ Docker network(`default`)にいるか

### Access の OAuth がスマホアプリから弾かれる
- スマホアプリは OAuth フローを処理できないため、**アプリ経由では Access を無効化する必要がある**
- 回避策:
  1. Public Hostname を 2 つ用意(ブラウザ用: Access あり / アプリ用: Access なし)
  2. アプリはローカルネットワーク経由でアクセス(VPN 等)

## MVP 用: ローカル専用モード

Cloudflare Tunnel を使わずローカルのみで試したい場合、`immich/docker-compose.yml` の `cloudflared` サービスを profile で分離する(Phase B で実装):

```yaml
cloudflared:
  profiles: ["public"]
  # ...
```

起動:
- ローカル専用: `docker compose up -d`(`cloudflared` は起動しない)
- 公開込み: `docker compose --profile public up -d`

ブラウザアクセスは `http://localhost:3000` で行う。

## セキュリティ考慮

- トンネルトークンは高権限のシークレット — `.env` のみに保存、共有 PC で作業しない
- Cloudflare Access を使わない場合、album-guard の認証だけが唯一の関門 → GUARD_JWT_SECRET は強力に
- `/album-guard/hash` エンドポイントは管理者用 — 将来的に Basic 認証等を追加検討(Phase 11.5 以降の課題)
