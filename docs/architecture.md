# システム構成(Photosaver v2)

専用 Linux ミニ PC 上の Immich を、Tailscale 経由で家族・友達と共有する構成。

## 全体像

```
[家族・友達のスマホ (Tailscale + Immich 公式アプリ)]
        │  node sharing で招待(人数無制限・無料)
        ▼
[Tailscale WireGuard mesh]
        │  https://photosaver.<tailnet>.ts.net(正規の Let's Encrypt 証明書)
        ▼
[ミニ PC: Ubuntu Server 24.04 / OptiPlex 7070 Micro]
        │  tailscale serve --bg --https=443 → 127.0.0.1:2283
        ▼
[immich-server :2283]  ← マルチユーザー・クォータ・共有アルバム(Immich 標準機能)
        ├─ immich-machine-learning(CPU 推論、QSV トランスコードは server 側)
        ├─ immich_postgres ─→ 内蔵 NVMe (ext4)  /srv/photosaver/postgres
        ├─ immich_redis (Valkey)
        └─ mount-guard ─→ HDD マーカーファイル検証(未マウント時は起動阻止)
        │
        ▼
[外付け HDD 4TB (Btrfs) /mnt/photo]  ← 写真原本 + 日次 DB ダンプ
```

## 設計方針(最重要)

**このシステムは「イベント写真の一時共有置き場」であり、恒久アーカイブではない。**

- 結婚式・旅行などでみんなが撮った写真を集めて、見て、各自が欲しいものを
  端末に保存するための場所
- **写真原本のバックアップは意図的に持たない**(HDD 故障 = 写真喪失を許容する)。
  この前提は参加者全員に共有する:「残したい写真は自分の端末に保存」
- 無料でできる保険だけ実施: Immich の日次 DB ダンプ(HDD 上、14世代)+
  cron で NVMe へミラー(`server/scripts/sync-db-dumps.sh`)。
  HDD が死んでも「何がいつ誰からアップされたか」の記録は残る
- 容量が逼迫したら大容量 HDD に買い替えて移行する(拡張パス: [operations.md](operations.md))

## コンポーネント責務

| コンポーネント | 責務 |
|---|---|
| Immich(v3 系にピン) | 写真管理のすべて。マルチユーザー、クォータ、共有アルバム、ML 検索 |
| Tailscale(node sharing) | 認証済みデバイスだけに到達性を与える。公開 URL は存在しない |
| tailscale serve | HTTPS 終端(ts.net の正規証明書)→ localhost:2283 |
| mount-guard(compose 内) | HDD 未マウント時の「空ディレクトリへの書き込み事故」防止 |
| Btrfs(HDD) | 月次 scrub によるビット腐敗検知(検知のみ。修復用の複製は無い) |
| ext4(NVMe) | OS / Docker / Postgres。DB は CoW ファイルシステムに置かない |

## 採用しなかった構成とその理由

| 案 | 却下理由 |
|---|---|
| album-guard(自作認証プロキシ)継続 | Immich v3 でアルバム内アセット列挙が `POST /api/search/metadata` に移り、パス intercept 型の保護に構造的な抜けが発生。標準のマルチユーザー + クォータで要件を満たせる。コードは学習成果として `album-guard/` に凍結保存 |
| Cloudflare Tunnel + 独自ドメイン公開 | 無料プランの 100MB リクエスト上限 × Immich にチャンクアップロード無し → スマホ動画のバックアップが壊れる。公開面の攻撃リスクも増える |
| Immich Public Proxy (IPP) | 「アプリを入れない人に共有リンクだけ見せる」用途の優れた既製品。現構成では全員がアプリ利用者なので不要。需要が出たら Tailscale Funnel + IPP を後付け(構成変更ゼロで追加可能) |
| NAS | 普及帯 NAS は CPU が弱く Immich の ML に不向き。NFS のランダム IOPS はローカルの数百分の一 |
| RAID / バックアップドライブ | 「一時置き場」の設計方針に対して過剰投資。クォータと容量監視で運用する |

## セキュリティモデル

- **到達性 = tailnet 招待者のみ**。ポート開放なし、公開 URL なし。
  Immich 公式も推奨する方式(「ゼロデイがあっても危険に晒されない」)
- アカウントは管理者(自分)が発行。友達は viewer/editor 権限の共有アルバムでやりとり
- 万一の共有ニーズ拡大時も、公開するのは読み取り専用の IPP に限定する(Immich 本体は非公開を維持)

## データ配置

| データ | 場所 | FS | 理由 |
|---|---|---|---|
| 写真原本(`upload/` `library/` `profile/`) | `/mnt/photo/immich-library` | Btrfs | scrub で劣化検知、大容量 HDD |
| サムネイル・変換動画 | 同上(再生成可能) | Btrfs | 容量が大きいだけで消えても再生成可 |
| Postgres データ | `/srv/photosaver/postgres` | ext4 (NVMe) | 公式要件: ローカル SSD、CoW 回避 |
| DB ダンプ | `/mnt/photo/.../backups/` + NVMe ミラー | 両方 | 唯一の多重化データ |
| compose / .env | `/srv/photosaver/` | ext4 (NVMe) | リポジトリ `server/` からコピー |

## 関連ドキュメント

- 機材と選定理由: [hardware.md](hardware.md)
- セットアップ手順: [new-server-setup.md](new-server-setup.md)
- 移行手順: [migration-runbook.md](migration-runbook.md)
- 日常運用: [operations.md](operations.md)
- Tailscale 詳細: [tailscale.md](tailscale.md)
- 旧設計(album-guard 時代)の資料: [legacy/](legacy/)
