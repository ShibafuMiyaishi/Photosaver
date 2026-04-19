# 運用手順

HPSS / Photosaver 環境の起動・停止・ログ・トラブルシューティングの運用マニュアル。

## 前提条件

- Windows 11 + Docker Desktop
- Node.js 20+(ローカル開発用)
- 外付けドライブを `E:\`(または任意のパス)に接続済み
- Cloudflare アカウント + 移管済ドメイン + Zero Trust 有効化
  (スマホアプリのアルバムパスワード認証はブラウザ経由のため、Cloudflare Tunnel は必須。詳細: [cloudflare-tunnel.md](cloudflare-tunnel.md))

## 初回セットアップ

### 1. リポジトリ取得
```powershell
cd C:\Users\fumiy\Desktop\code
git clone git@github.com:ShibafuMiyaishi/Photosaver.git
cd Photosaver
```

### 2. 外付けドライブ準備
詳細: [external-drive.md](external-drive.md)

```powershell
mkdir E:\Photo\immich-library
mkdir E:\Photo\guard
echo. > E:\Photo\.drive-check
echo {} > E:\Photo\guard\album-passwords.json
```

### 3. Docker Desktop File Sharing
Settings → Resources → File sharing → `E:\` を追加 → Apply & Restart

### 4. 環境変数ファイル作成
```powershell
copy .env.example .env
copy immich\.env.example immich\.env
```

`immich/.env` の以下を必ず変更:
- `DB_PASSWORD` — 強力なランダム文字列
- `GUARD_JWT_SECRET` — 32 文字以上のランダム文字列(生成: `openssl rand -hex 32`)

### 5. Cloudflare Tunnel セットアップ
`.env` に以下を記入:
- `CLOUDFLARE_API_TOKEN`(Dashboard で発行、scope は `docs/cloudflare-tunnel.md` 参照)
- `CLOUDFLARE_ACCOUNT_ID`(Dashboard 右サイドバー)
- `CLOUDFLARE_ZONE_NAME`(移管済ドメイン)
- `CLOUDFLARE_HOSTNAME`(公開する hostname)

実行:
```powershell
node scripts/cloudflare-setup.mjs
```

tunnel 作成 + ingress 設定 + DNS CNAME 作成が自動で行われ、`immich/.env` の `CLOUDFLARE_TUNNEL_TOKEN` が自動書き込みされる。

### 6. スタック起動
```powershell
cd immich
docker compose --profile public up -d --build
```
`--profile public` で `cloudflared` も含めて全コンテナ起動。

### 7. E2E 検証
```powershell
node scripts/cloudflare-verify.mjs
```
tunnel 状態・DNS・HTTP の 3 レイヤ検証。全 ✅ で Cloudflare Tunnel 完全動作。

## 日常運用コマンド

### 起動 / 停止 / 再起動

```powershell
# 全体起動(Cloudflare Tunnel 込み)
cd immich
docker compose --profile public up -d

# ローカル専用モード(cloudflared なし、localhost のみアクセス可)
docker compose up -d

# 全体停止
docker compose down

# album-guard のみ再ビルド+再起動
docker compose up -d --build album-guard

# 特定サービスの再起動
docker compose restart album-guard
```

### ログ確認

```powershell
# album-guard ログを追随
docker compose logs -f album-guard

# 最近 100 行
docker compose logs --tail 100 album-guard

# 全サービス
docker compose logs -f
```

### ヘルスチェック

```powershell
curl http://localhost:3000/album-guard/health      # album-guard
curl http://localhost:3000/api/server/ping          # Immich(プロキシ経由)
docker compose ps                                    # コンテナ状態一覧
```

## Claude Code での操作

Claude Code 内から以下のカスタムスキルが使える:

| スキル | 用途 |
|---|---|
| `/drive-check` | 外付けドライブの接続・書き込み可・空き容量を検証 |
| `/compose-up` | 全スタック起動 + ヘルスチェック |
| `/test-auth` | E2E 認証テスト(仕様書 11.8 の T1〜T7) |
| `/hash-password <pw>` | bcrypt ハッシュ生成 |
| `/album-add` | アルバムパスワードを対話で登録 |

また、専門サブエージェント:

- `auth-reviewer` — 認証コードのセキュリティレビュー
- `docker-debugger` — Docker / compose トラブルシュート

## トラブルシューティング

### album-guard が起動しない

1. `docker compose logs album-guard` でエラー確認
2. `ENOENT` エラー → 外付けドライブが見えていない。Docker Desktop の File Sharing を確認
3. `EADDRINUSE` エラー → port 3000 が使用中。`immich/.env` で `GUARD_PORT=3001` 等に変更
4. `JsonParseError` → `album-passwords.json` の JSON 文法エラー。バリデータで修正

### Immich へのリクエストが 502

1. album-guard から immich-server への疎通
   ```powershell
   docker exec album_guard wget -qO- http://immich-server:2283/api/server/ping
   ```
2. NG なら immich-server のステータス確認
3. immich-server は cold start に ~60 秒かかる場合あり(healthcheck の `start_period` で吸収)

### パスワード認証が通らない

1. `album-passwords.json` の UUID とアルバム UUID が一致しているか(ブラウザ URL で再確認)
2. ハッシュが正しいか(`/hash-password` で再生成して比較)
3. ホットリロードが走ったかログで確認(`パスワード設定をロード: N アルバム`)
4. JWT 期限切れ → クライアント側を再ログイン

### 外付けドライブが抜けた / ドライブレターが変わった

1. ドライブを再接続。別ドライブレターになっていれば `.env` の `PHOTO_STORAGE_PATH` と `immich/.env` の同変数を更新
2. `docker compose restart` で再マウント
3. 恒久対策: Windows の「ディスクの管理」でドライブレターを固定

## 自動整形 / Lint (Phase B で有効化)

Phase B で album-guard/package.json が作成された後、`.claude/settings.json` の
`PostToolUse` フックに Prettier / ESLint を追加する予定。現状(Phase A)は
`Stop` フックで `git status --short` を表示するのみ。

## バックアップ

### 対象

- `E:\Photo\immich-library\` — 写真本体(大容量、別 HDD 推奨)
- `E:\Photo\guard\album-passwords.json` — パスワードハッシュ(小容量、暗号化 USB 等推奨)
- `immich/.env` — シークレット(絶対に平文で他人に渡さない)

現段階では手動コピーのみ。将来 `scripts/backup.mjs` で自動化予定。

## 緊急時オペレーション

### 全ユーザーを強制ログアウト
`GUARD_JWT_SECRET` を変更して album-guard を再起動:

```powershell
# 新シークレット生成
openssl rand -hex 32
# immich/.env の GUARD_JWT_SECRET を書き換えて保存
cd immich
docker compose restart album-guard
```

既存 JWT はすべて検証失敗になる → 全員再ログイン。

### データ破損時

- Immich DB(Docker volume): `docker volume` のバックアップから復元
- 写真本体: 別ドライブのバックアップから復元(未バックアップ分は消失)
- パスワード設定: バックアップがあれば復元、なければ `/album-add` で再設定
