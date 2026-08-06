# legacy/ — 旧設計(Phase A/B: Windows + album-guard 時代)の資料

2026年8月の方針転換([architecture.md](../architecture.md) 参照)以前のドキュメント。
**現在の運用には使わない**が、経緯の記録および `immich/`(旧 Windows スタック)と
`album-guard/`(凍結した自作認証プロキシ)を動かす場合の参照用に保存している。

| ファイル | 内容 | 廃止理由 |
|---|---|---|
| `external-drive.md` | Windows + Docker Desktop での外付けドライブ設定 | 新サーバーは Linux + Btrfs(new-server-setup.md に統合) |
| `password-management.md` | album-guard のアルバムパスワード管理 | album-guard 凍結。認可は Immich 標準のユーザー/クォータ/共有に移行 |
| `phase-11.5-design.md` | Immich UI への認証スクリプト自動注入の設計 | album-guard 凍結により計画自体を終了 |

album-guard を凍結した経緯: Immich v3(2026年7月)でアルバム内アセットの列挙が
`POST /api/search/metadata` に移り、パスベースの intercept 型保護に構造的な抜けが
生じたため。詳細な調査記録はコミット履歴と architecture.md を参照。
