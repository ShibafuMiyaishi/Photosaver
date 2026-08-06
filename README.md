# Photosaver

Immich を専用ミニ PC でセルフホストし、**家族・友達とイベント写真を共有する一時置き場**を
作るプロジェクト。結婚式や旅行でみんなが撮った写真を集めて、見て、各自が欲しいものを
端末に保存するための場所。

## 特徴

- 📱 参加者は **Immich 公式アプリ**をそのまま使う(個別アカウント + 容量クォータ)
- 🌐 外部アクセスは **Tailscale**(ドメイン不要・無料・招待した端末のみ到達可。
  友達は node sharing で人数無制限に招待できる)
- 💾 写真は外付け HDD(Btrfs)、DB は内蔵 NVMe — 公式推奨のストレージ分離
- ⚡ Intel Quick Sync によるハードウェア動画変換
- 🎯 **設計方針: 一時共有置き場**。写真原本のバックアップは持たない(DB ダンプのみ多重化)。
  「残したい写真は各自の端末へ」が運用ルール

## 構成

```
スマホ(Tailscale + Immich アプリ)
  → Tailscale mesh → tailscale serve (HTTPS)
  → ミニ PC (Ubuntu Server 24.04 / OptiPlex 7070 Micro)
      └─ Immich v3 (docker compose)
           ├─ Postgres → 内蔵 NVMe
           └─ 写真原本 → 外付け HDD 4TB (Btrfs)
```

詳細: [docs/architecture.md](docs/architecture.md)

## ディレクトリ概要

```
Photosaver/
├─ server/           本番サーバー用 compose 定義(新ミニ PC 向け)★現行
├─ docs/             ドキュメント(日本語)★現行
│   └─ legacy/       旧設計(Windows + album-guard 時代)の資料
├─ album-guard/      自作認証プロキシ(凍結。学習成果として保存)
├─ immich/           旧 Windows 検証環境の compose(凍結)
├─ scripts/          旧環境の補助スクリプト
├─ CLAUDE.md         Claude Code 向けプロジェクト指示書
├─ .claude/          Claude Code 設定
└─ .github/          CI ワークフロー
```

## ドキュメント(読む順)

1. 🛒 [購入機材リストと選定理由](docs/hardware.md)
2. 🔧 [新サーバー セットアップ手順(ゼロから完成まで)](docs/new-server-setup.md)
3. 🚚 [移行ランブック(Windows 検証環境からのデータ移行)](docs/migration-runbook.md)
4. 📐 [システム構成と設計判断](docs/architecture.md)
5. 🔁 [日常運用(月次更新・容量管理・トラブル対応)](docs/operations.md)
6. 🌐 [Tailscale 詳細(友達の招待手順・既知の制約)](docs/tailscale.md)

## album-guard について(凍結)

Phase A/B で開発した自作の認証リバースプロキシ(JWT + bcrypt によるアルバム単位
パスワード保護、Vitest 35 テスト、CI 付き)。Immich v3 の API 変更でパス intercept 型の
保護に構造的な抜けが生じたこと、および Immich 標準機能(マルチユーザー + パスワード付き
共有リンク)で要件を満たせることから、**2026年8月に開発を凍結**した。
コードは学習・ポートフォリオ成果として [album-guard/](album-guard/) に保存している。
経緯の詳細: [docs/architecture.md](docs/architecture.md) / [docs/legacy/](docs/legacy/)

## 技術スタック

- Immich v3(upstream・無改造)/ Docker Compose / Ubuntu Server 24.04 LTS
- Tailscale(node sharing + tailscale serve)
- 凍結分: Node.js 20 / Express 4 / Vitest

## 関連

- Immich 公式: https://immich.app/
- Tailscale: https://tailscale.com/
- Immich Public Proxy(将来の公開共有用の候補): https://github.com/alangrainger/immich-public-proxy
