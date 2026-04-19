# Photosaver (HPSS Phase 11)

Immich ベースの自宅用写真保管システムに、**アルバム単位のパスワード保護**を追加するリバースプロキシ `album-guard` を開発するプロジェクト。HPSS 仕様書 Phase 11 追補版の実装。

## 特徴

- 🔒 アルバム単位のパスワード保護 (JWT + bcrypt)
- 🖼 写真データは **外付けドライブ** に保存(容量拡張容易、ドライブ交換で移行可能)
- 🌐 Cloudflare Tunnel 経由で外部アクセス(ローカル専用でも動作)
- 🐳 Docker / docker-compose による統合デプロイ
- ♻️ パスワード設定はホットリロード(コンテナ再起動不要)

## ディレクトリ概要

```
Photosaver/
├─ CLAUDE.md         Claude Code 向けプロジェクト指示書
├─ album-guard/      認証プロキシ(Phase B で実装)
├─ immich/           Immich + 関連サービスの compose 定義
├─ docs/             運用ドキュメント(日本語)
├─ scripts/          補助スクリプト
├─ .claude/          Claude Code 設定(skills / agents / rules / mcp)
└─ .github/          CI ワークフロー
```

## クイックスタート(Phase B 完了後)

1. リポジトリをクローン
2. 外付けドライブを用意し、`E:/Photo/immich-library` と `E:/Photo/guard` を作成(詳細: [docs/external-drive.md](docs/external-drive.md))
3. Docker Desktop の File Sharing に `E:\` を追加
4. `.env` と `immich/.env` を作成(テンプレ参照)。`GUARD_JWT_SECRET` と `DB_PASSWORD` を設定
5. 起動: `cd immich && docker compose up -d --build`
6. 動作確認: `curl http://localhost:3000/album-guard/health`

詳しくは [docs/operations.md](docs/operations.md)。

## ドキュメント

- 📐 [システム構成](docs/architecture.md)
- 🔧 [運用手順](docs/operations.md)
- 🔑 [アルバムパスワード管理](docs/password-management.md)
- 💾 [外付けドライブ運用](docs/external-drive.md)
- ☁️ [Cloudflare Tunnel 設定](docs/cloudflare-tunnel.md)
- 🔮 [Phase 11.5 将来設計(Immich UI 統合)](docs/phase-11.5-design.md)

## Claude Code で開発する場合

本プロジェクトは Claude Code で開発することを前提に設計されています。ルート `CLAUDE.md` と `.claude/` 配下の設定により、以下が利用可能:

**カスタムスキル:**
- `/hash-password <パスワード>` — bcrypt ハッシュ生成
- `/album-add` — アルバムパスワード登録(対話式)
- `/drive-check` — 外付けドライブ検証
- `/compose-up` — スタック起動 + ヘルスチェック
- `/test-auth` — E2E 認証テスト

**専門サブエージェント:**
- `auth-reviewer` — 認証コードのセキュリティレビュー
- `docker-debugger` — Docker / compose トラブルシュート

**MCP サーバー (`.claude/mcp.json`):**
- Filesystem / GitHub / Docker / Playwright

## 開発フェーズ

- **Phase A — セットアップ(✅ 完了)**: ドキュメント・規約・Claude Code 設定の整備
- **Phase B — 実装**: album-guard のコード、docker-compose.yml、テスト、CI
- **Phase 11.5 — 拡張(将来)**: Immich Web UI への HTML 自動注入でパスワードプロンプトを統合

## 技術スタック

- Node.js 20 / Express 4
- jsonwebtoken 9 / bcryptjs 2.4 / http-proxy-middleware 3
- Vitest(単体テスト)
- Docker / docker-compose
- Cloudflare Tunnel
- Immich (upstream)

## ライセンス

(未定)

## 関連

- Immich 公式: https://immich.app/
- Cloudflare Zero Trust: https://one.dash.cloudflare.com/
