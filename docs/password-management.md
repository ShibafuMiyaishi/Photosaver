# アルバムパスワード管理手順

album-guard が保護するアルバムと、そのパスワードを管理する運用マニュアル。

## 設定ファイルの場所

`E:\Photo\guard\album-passwords.json`(外付けドライブ上、git 管理外)

コンテナ内では `/app/data/album-passwords.json` にマウントされる(`immich/.env` の `GUARD_PASSWORDS_FILE`)。

## ファイル形式

```json
{
  "<albumUUID>": {
    "label": "表示用の名前(任意)",
    "hash": "$2b$10$...",
    "expiresIn": "24h"
  }
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| キー (UUID) | ◎ | Immich のアルバム UUID(36 文字) |
| `label` | △ | 管理メモ(認証レスポンスに含まれる) |
| `hash` | ◎ | bcrypt ハッシュ(10 ラウンド) |
| `expiresIn` | △ | JWT 有効期限(例: `24h`, `72h`, `7d`)。未指定時は `GUARD_JWT_EXPIRES_IN` 環境変数 |

空ファイル(`{}`)でも動作する(保護アルバムなし = 全通過)。

## 新規アルバムにパスワードを設定

### 推奨: Claude Code スキル

```
/album-add
```

UUID・ラベル・パスワード・有効期限を対話で入力 → ハッシュ生成と JSON 追記まで自動。

### 手動

1. **UUID 取得**: Immich Web UI でアルバムを開く → URL 末尾の 36 文字
   ```
   https://photos.example.com/albums/550e8400-e29b-41d4-a716-446655440000
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   ```

2. **ハッシュ生成**(2 通り)

   album-guard 起動中:
   ```powershell
   curl -X POST http://localhost:3000/album-guard/hash `
     -H "Content-Type: application/json" `
     -d '{"password":"your-password"}'
   ```

   起動前(Node.js ワンライナー、`album-guard/` 内で実行):
   ```powershell
   node -e "require('bcryptjs').hash('your-password',10).then(console.log)"
   ```

3. **JSON 追記**:
   ```json
   {
     "既存UUID": { ... },

     "新しいUUID": {
       "label": "家族アルバム",
       "hash": "$2b$10$...",
       "expiresIn": "72h"
     }
   }
   ```

4. **保存**: ホットリロードが走るため、コンテナ再起動不要。ログで確認:
   ```
   [album-guard] パスワード設定をロード: 2 アルバム
   ```

## パスワード変更

1. 新パスワードのハッシュを生成
2. 該当 UUID の `hash` フィールドを書き換えて保存
3. ホットリロード待ち(数秒)

**注意**: 既存 JWT は有効期限まで使える。即座に無効化したい場合は下記「強制ログアウト」。

## パスワード解除

該当 UUID のエントリごと削除して保存:

```json
{
  "残すUUID": { ... }
  // "消すUUID" は丸ごと削除
}
```

空の場合は `{}` と書けば OK。

## 強制ログアウト(全アルバム)

`GUARD_JWT_SECRET` を変更して album-guard を再起動:

```powershell
# 1. 新シークレット生成
openssl rand -hex 32

# 2. immich/.env の GUARD_JWT_SECRET を新値に書き換え

# 3. album-guard 再起動
cd immich
docker compose restart album-guard
```

これで既存 JWT はすべて検証失敗になる。全員が再ログイン必須。

## セキュリティ運用上の注意

- **ファイルは gitignore 済み**: 絶対にコミットしない(`.gitignore` で多重防御)
- **ハッシュはバックアップ対象**: 紛失するとパスワードの再設定が必要(原理上、ハッシュから復元不可能)
- **JWT シークレットも同様**: 変更すると既存ログインが全部切れる
- **パスワード自体はどこにも保存されない**: bcrypt の仕様上、ハッシュから復元不可
- **強度**: bcrypt 10 ラウンド(現代のハードウェアで 1 ハッシュ計算 ~100ms)。総当たりに現実的な時間がかかる

## よくあるミス

- **UUID のタイポ** — ブラウザ URL からそのままコピペする
- **JSON 文法エラー** — 末尾のカンマ禁止、ダブルクォート必須
- **改行コード** — CRLF で保存しないこと(`.gitattributes` で LF 固定推奨)
- **パスワードの取り違え** — `/hash-password` で生成したハッシュを、そのパスワードと同じ行に書く
