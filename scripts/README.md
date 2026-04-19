# scripts/

Photosaver / HPSS プロジェクトの補助スクリプト群。Node.js 20 ESM で実装。

## 実装済みスクリプト

| ファイル | 用途 |
|---|---|
| `check-drive.mjs` | 外付けドライブ(`PHOTO_STORAGE_PATH`)の接続・書込・空き容量・Docker File Sharing 検証 |
| `generate-hash.mjs` | bcrypt 10 ラウンドでパスワードハッシュ生成(stdin 推奨、album-guard 未起動時の代替) |
| `verify-env.mjs` | `.env` / `immich/.env` に必須キー + placeholder が残っていないか検査 |
| `tailscale-verify.mjs` | Tailscale CLI 検出 + status + serve 設定 + album-guard 到達性の統合検証 |
| `_env.mjs` | `.env` / `immich/.env` を読み込む内部ユーティリティ |

## Phase B 以降で実装予定

| ファイル | 用途 |
|---|---|
| `seed-albums.mjs` | 複数アルバムのパスワードを CSV から一括登録 |
| `backup.mjs` | `PHOTO_STORAGE_PATH` を別ドライブに robocopy で差分バックアップ |

## 実行方法

各スクリプトは Node.js 20 で直接実行:

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

## 作成時のルール

- ES Modules (`.mjs`) を使用
- 依存は `album-guard/package.json` のものを流用(`cd album-guard && npm install` が前提)
- 破壊的操作(削除・上書き)は `--confirm` フラグ必須
- パスワード等のシークレットを引数で受ける場合、`process.argv` ではなく `stdin` を推奨(shell history に残さない)
- 外部 API 呼び出し(GitHub 等)は Node 20 built-in `fetch` を直接使う(追加 dep を避ける)
- CLI 呼び出し(`tailscale`, `docker` 等)は `execSync` を使い、失敗時は明確なエラーと次アクションを表示する
