# album-guard

HPSS Phase 11 の **アルバム単位パスワード認証リバースプロキシ**。Immich の前段に置き、`/api/albums/:uuid*` への API アクセスを JWT で保護する。

> **凍結(2026年8月)**: Immich v3 でアルバム内アセットの列挙が `POST /api/search/metadata` に移り、パス intercept 型の保護に構造的な抜けが生じたため開発を終了した。現行構成(v2)では使わない。バグ修正のみ(明示的な依頼があった場合)。経緯: [docs/architecture.md](../docs/architecture.md)

## ローカル開発

```bash
# 依存関係
cd album-guard
npm install

# テスト
npm test                 # run once
npm run test:watch       # watch mode
npm run test:coverage    # カバレッジ付き

# Lint / Format
npm run lint
npm run lint:fix
npm run format
```

## Immich なしで動作確認

Immich コンテナなしで album-guard 単体を起動する場合:

```bash
# 必須: 32 文字以上のランダム JWT secret
export GUARD_JWT_SECRET=$(openssl rand -hex 32)

# パスワード設定ファイル(未指定時は /app/data/album-passwords.json。見つからない場合は全アルバム通過モードで起動)
export GUARD_PASSWORDS_FILE="$(pwd)/../tmp/album-passwords.json"

# 起動(Immich 未接続なので /api/* は 502/503 を返す)
npm start
```

ヘルスチェック:

```bash
curl http://localhost:3000/album-guard/health
# => {"status":"ok",...}
```

## パスワードハッシュ生成

```bash
# album-guard 起動中:
curl -X POST http://localhost:3000/album-guard/hash \
  -H 'Content-Type: application/json' \
  -d '{"password":"my-password"}'

# 未起動時(プロジェクトルートから):
node scripts/generate-hash.mjs
```

## 設計方針

- **Plain JavaScript / CommonJS** — 仕様書が pre-validated な JS のため TS 化しない
- **Node 20** built-in fetch / --watch / fs.watch を活用、`nodemon` 等の devDep は追加しない
- **依存固定**: `express` / `http-proxy-middleware` v3 / `jsonwebtoken` v9 / `bcryptjs` / `morgan` / `dotenv` のみ。`axios` / `lodash` / `helmet` 等は追加禁止
- **テスト/ログ成果物**は repo 直下 `../tmp/` へ出力(`.claude/rules/testing.md`)
- **認証不変条件**は `.claude/rules/auth.md` を参照。`auth-reviewer` subagent で監査可

## ディレクトリ

```
album-guard/
├─ src/
│  ├─ config.js          環境変数 + 起動時バリデータ
│  ├─ auth.js            JWT + bcrypt + ホットリロード
│  ├─ proxy.js           UUID 抽出 + トークン検証 + Immich 転送
│  ├─ index.js           Express 配線 + 全エンドポイント
│  └─ pages/
│     ├─ login.js        /album-guard/login HTML 生成
│     └─ inject.js       /album-guard/inject.js スクリプト生成
├─ test/
│  ├─ fixtures/          テスト用パスワード設定(passwords.js が実行時に bcrypt ハッシュを生成)
│  ├─ helpers/           Vitest setupFiles + tmp/ ヘルパー
│  ├─ config.test.js
│  ├─ auth.test.js
│  └─ proxy.test.js
├─ package.json
├─ Dockerfile
├─ eslint.config.js
└─ vitest.config.js
```
