# scripts/ — 旧 Windows 環境の補助スクリプト(凍結)

Phase A/B(Windows + Docker Desktop + album-guard)の検証環境向けに作った補助スクリプト群。
Node.js 20 ESM で実装。**現行のミニ PC 構成(v2)では使わない**。v2 の手順は
[docs/new-server-setup.md](../docs/new-server-setup.md)、ゲスト用アップロード窓口の
スクリプトは [guest-gateway/scripts/](../guest-gateway/scripts/) を参照。

| ファイル | 用途 |
|---|---|
| `check-drive.mjs` | 外付けドライブ(`PHOTO_STORAGE_PATH`)の接続・書込・空き容量・Docker File Sharing 検証 |
| `generate-hash.mjs` | bcrypt 10 ラウンドでパスワードハッシュ生成(stdin 推奨、album-guard 未起動時の代替) |
| `verify-env.mjs` | `.env` / `immich/.env` に必須キー + placeholder が残っていないか検査 |
| `tailscale-verify.mjs` | Tailscale CLI 検出 + status + serve 設定 + album-guard 到達性の統合検証 |
| `_env.mjs` | `.env` / `immich/.env` を読み込む内部ユーティリティ |

## 実行方法

各スクリプトは Node.js 20 で直接実行(`generate-hash.mjs` は `album-guard/` の依存を使うため
`cd album-guard && npm install` が前提):

```bash
node scripts/check-drive.mjs
echo "my-password" | node scripts/generate-hash.mjs
node scripts/verify-env.mjs
node scripts/tailscale-verify.mjs
```

## 終了コード規約

| code | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 検証失敗 / ユーザー対処が必要 |
| 2 | 環境不備(.env がない等) |
