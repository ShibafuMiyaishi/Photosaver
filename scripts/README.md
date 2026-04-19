# scripts/

Phase B 以降で実装する補助スクリプト群のプレースホルダ。

## 実装予定のスクリプト

| ファイル | 用途 |
|---|---|
| `check-drive.mjs` | 外付けドライブ(`PHOTO_STORAGE_PATH`)の接続・書き込み可・空き容量を検証 |
| `generate-hash.mjs` | bcrypt ハッシュ生成(album-guard 未起動時にも使える) |
| `verify-env.mjs` | `.env` / `immich/.env` に必須変数が埋まっているか検証 |
| `seed-albums.mjs` | 複数アルバムのパスワードを CSV から一括登録 |
| `backup.mjs` | `PHOTO_STORAGE_PATH` を別ドライブに robocopy で差分バックアップ |

## 実行方法(将来)

各スクリプトは Node.js 20 で直接実行:

```powershell
node scripts/check-drive.mjs
node scripts/generate-hash.mjs "my-password"
```

## 作成時のルール

- ES Modules (`.mjs`) を使用(単体実行中心)
- 依存は `album-guard/package.json` のものを流用(`cd album-guard && npm install` が前提)
- 破壊的操作(削除・上書き)は `--confirm` フラグ必須
- パスワード等のシークレットを引数で受ける場合、`process.argv` ではなく `stdin` を推奨(shell history に残さない)
- 終了コード: 0=成功 / 1=検証失敗 / 2=環境不備
