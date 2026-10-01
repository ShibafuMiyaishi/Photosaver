# Photosaver

Immich を専用ミニ PC でセルフホストし、**家族・友達とイベント写真を共有する一時置き場**を
作るプロジェクト。結婚式や旅行でみんなが撮った写真を集めて、見て、各自が欲しいものを
端末に保存するための場所。

## 特徴

- 📱 参加者は **Immich 公式アプリ**をそのまま使う(個別アカウント + 容量クォータ)
- 🌐 外部アクセスは **Tailscale**(ドメイン不要・無料・招待した端末のみ到達可。
  友達は node sharing で人数無制限に招待できる)
- 📤 **ゲスト用アップロード窓口(guest-gateway)**: アカウントも Tailscale も無いイベントの
  ゲストが、リンク + 合言葉だけで写真・動画を 1 つのアルバムへ送れる。
  イベント期間だけ専用の Tailscale ノードで公開し、Immich 本体は tailnet 内のまま
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

イベントのゲスト(ブラウザ)
  → Tailscale Funnel(期間限定・専用ノード tag:wedding-gw)
  → guest-gateway(別 compose プロジェクト wedding-gw)
  → 内部ネットワーク photosaver_gw → immich-server だけに到達
```

詳細: [docs/architecture.md](docs/architecture.md) / [docs/guest-gateway.md](docs/guest-gateway.md)

## guest-gateway でできること

- 合言葉 + ニックネームでログインし、写真・動画を**再開可能なアップロード(tus)**で送る
  (Immich のアルバム共有リンク経由で 1 つのアルバムに追加)
- 「みんなの写真」で閲覧・動画再生・1 件ずつ保存
- **まとめて保存**: iPhone / iPad は共有メニューから写真アプリへ、Android は端末のダウンロードへ、
  パソコンは ZIP(約 2 GB ごとに分割)
- 自分の投稿の削除(幹事は管理者の合言葉で全件削除可)、受付期限で自動終了、速度検証モード
- 補助スクリプト: Immich 側のイベント準備(`setup-event.js`)、当日の状況確認(`event-status.js`)

状態: Mac 側の実装は完了。ミニ PC へのデプロイ・Funnel の速度検証・実機確認が残っている
([.claude/handoff/tasks.md](.claude/handoff/tasks.md))。

## ディレクトリ概要

```
Photosaver/
├─ server/           本番サーバー用 compose 定義(ミニ PC 向け)★現行
├─ guest-gateway/    イベント用のゲスト用アップロード窓口(Node.js)★現行
├─ docs/             ドキュメント(日本語)★現行
│   └─ legacy/       旧設計(Windows + album-guard 時代)の資料
├─ album-guard/      自作認証プロキシ(凍結。学習成果として保存)
├─ immich/           旧 Windows 検証環境の compose(凍結)
├─ scripts/          旧 Windows 環境の補助スクリプト(凍結)
├─ CLAUDE.md         Claude Code 向けプロジェクト指示書
├─ .claude/          Claude Code 設定(handoff/ は Mac ⇄ 自宅 PC の作業引き継ぎ)
└─ .github/          CI ワークフロー
```

## ドキュメント(読む順)

1. 🛒 [購入機材リストと選定理由](docs/hardware.md)
2. 🔧 [新サーバー セットアップ手順(ゼロから完成まで)](docs/new-server-setup.md)
3. 🚚 [移行ランブック(Windows 検証環境からのデータ移行)](docs/migration-runbook.md)
4. 📐 [システム構成と設計判断](docs/architecture.md)
5. 🔁 [日常運用(月次更新・容量管理・トラブル対応)](docs/operations.md)
6. 🌐 [Tailscale 詳細(友達の招待手順・既知の制約)](docs/tailscale.md)
7. 📤 [ゲスト用アップロード窓口(設計・準備・当日の運用)](docs/guest-gateway.md)
   — コードとデプロイ手順は [guest-gateway/README.md](guest-gateway/README.md)

## album-guard について(凍結)

Phase A/B で開発した自作の認証リバースプロキシ(JWT + bcrypt によるアルバム単位
パスワード保護、Vitest によるテスト、CI 付き)。Immich v3 の API 変更でパス intercept 型の
保護に構造的な抜けが生じたこと、および Immich 標準機能(マルチユーザー + パスワード付き
共有リンク)で要件を満たせることから、**2026年8月に開発を凍結**した。
コードは学習・ポートフォリオ成果として [album-guard/](album-guard/) に保存している。
経緯の詳細: [docs/architecture.md](docs/architecture.md) / [docs/legacy/](docs/legacy/)

## 技術スタック

- Immich v3(upstream・無改造)/ Docker Compose / Ubuntu Server 24.04 LTS
- Tailscale(node sharing + tailscale serve。guest-gateway のみ Funnel)
- guest-gateway: Node.js 24 / Express 5 / node:sqlite / tus / PhotoSwipe / Vitest
- CI: GitHub Actions(album-guard と guest-gateway の lint + テスト)
- 凍結分(album-guard): Node.js 20 / Express 4 / Vitest

## 関連

- Immich 公式: https://immich.app/
- Tailscale: https://tailscale.com/
- Immich Public Proxy(将来の閲覧専用共有用の候補): https://github.com/alangrainger/immich-public-proxy
