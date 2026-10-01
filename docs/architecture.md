# システム構成(Photosaver v2)

専用 Linux ミニ PC 上の Immich を、Tailscale 経由で家族・友達と共有する構成。
イベント時だけ、アカウントを持たないゲスト向けのアップロード窓口(guest-gateway)を追加で公開する。

## 全体像

```
[家族・友達のスマホ (Tailscale + Immich 公式アプリ)]      [イベントのゲスト(ブラウザのみ)]
        │  node sharing で招待                                  │  Tailscale Funnel(期間限定の公開)
        ▼                                                       ▼
[Tailscale WireGuard mesh(tailnet 内のみ)]             [窓口専用ノード tag:wedding-gw]
        │  https://<ミニPC>.<tailnet>.ts.net                    │  ts サイドカー → guest-gateway
        ▼                                                       │  (別 compose プロジェクト wedding-gw)
[ミニ PC: Ubuntu Server 24.04 / OptiPlex 7070 Micro]            │
        │  tailscale serve --bg --https=443 → 127.0.0.1:2283    │  内部ネットワーク photosaver_gw
        ▼                                                       ▼  (internal、immich-server だけが参加)
[immich-server :2283]  ← マルチユーザー・クォータ・共有アルバム(Immich 標準機能)
        ├─ immich-machine-learning(CPU 推論。QSV トランスコードは server 側)
        ├─ immich_postgres ─→ 内蔵 NVMe (ext4)  /srv/photosaver/postgres
        ├─ immich_redis (Valkey)
        └─ mount-guard ─→ HDD マーカーファイル検証(未マウント時は起動阻止)
        │
        ▼
[外付け HDD 4TB (Btrfs) /mnt/photo]  ← 写真原本 + 日次 DB ダンプ + 窓口のステージング
```

窓口ノードとミニ PC 本体は同じマシン上で動くが、Tailscale 上は別ノード。
Funnel で外に出るのは窓口ノードだけで、Immich(本体の 443 serve)は tailnet 内のまま。

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
| Immich(`v3` メタタグでメジャー固定、公式イメージを無改造) | 写真管理のすべて。マルチユーザー、クォータ、共有アルバム、ML 検索 |
| Tailscale(node sharing) | 認証済みデバイスだけに到達性を与える。Immich に公開 URL は存在しない |
| tailscale serve(ホスト) | HTTPS 終端(ts.net の正規証明書)→ localhost:2283 |
| mount-guard(compose 内) | `${UPLOAD_LOCATION}` 直下のマーカーを確認し、HDD 未マウント時の「空ディレクトリへの書き込み事故」を防ぐ |
| guest-gateway(イベント時のみ) | ゲストの合言葉ログイン、tus による再開可能アップロード、1 アルバムへの取り込み・閲覧・保存・削除。期限で自動終了([guest-gateway.md](guest-gateway.md)) |
| ts サイドカー(`tag:wedding-gw`) | 窓口専用の Tailscale ノード。Funnel の HTTPS 終端 → 窓口(127.0.0.1:8080) |
| `photosaver_gw` ネットワーク | 窓口から immich-server の API だけに届く内部ネットワーク(外部への出口なし) |
| Btrfs(HDD) | 月次 scrub によるビット腐敗検知(検知のみ。修復用の複製は無い) |
| ext4(NVMe) | OS / Docker / Postgres。DB は CoW ファイルシステムに置かない |

## セキュリティモデル

- **Immich の到達性 = tailnet 招待者のみ**。ポート開放なし(ポートは 127.0.0.1 バインド)、公開 URL なし。
  Immich 公式も推奨する方式(「ゼロデイがあっても危険に晒されない」)
- アカウントは管理者(自分)が発行。友達は viewer/editor 権限の共有アルバムでやりとり
- Immich 本体をアプリ無しの人に見せる需要が出た場合も、公開するのは読み取り専用の
  Immich Public Proxy(Funnel 経由)に限定する([tailscale.md](tailscale.md))

### 例外: guest-gateway の公開(2026-10 承認)

結婚式などで、アカウントも Tailscale も持たないゲストに写真・動画を上げてもらうため、
窓口だけを Funnel で期間限定公開する。Immich 本体を公開しないための構成:

- **専用の Tailscale ノード**(`tag:wedding-gw`、別 compose プロジェクト `wedding-gw` の ts サイドカー)で公開する。
  ホストの serve 設定に触れないので、窓口の起動・停止が Immich の tailnet 公開に影響しない。
  URL にポート番号もミニ PC のホスト名も出ない
- **持つ鍵を最小にする**: 結婚式専用 Immich ユーザーの 1 アルバム分の共有リンクキーと、
  `asset.delete` 権限だけの API キー。漏れても影響はそのアルバム・そのユーザーの写真に限られる
- **ネットワーク分離**: 窓口と Immich の接点は `photosaver_gw`(`internal: true`)だけ。
  参加するのは immich-server のみで、Redis・Postgres は決して参加させない
  (`server/docker-compose.yml` 差分 5)。窓口が乗っ取られても届くのは Immich の API だけ
- 止めるときは `cd ~ && docker compose -p wedding-gw down`。
  ⚠️ ミニ PC 本体で `tailscale funnel reset` / `serve reset` は使わない(Immich の tailnet 公開まで消える)
- Funnel の帯域は非公開のため、実機で速度を測ってから採否を決める
  (不合格時の代替候補は [guest-gateway.md](guest-gateway.md) の「速度の事前検証」)

## 採用しなかった構成とその理由

| 案 | 却下理由 |
|---|---|
| album-guard(自作認証プロキシ)継続 | Immich v3 でアルバム内アセット列挙が `POST /api/search/metadata` に移り、パス intercept 型の保護に構造的な抜けが発生。標準のマルチユーザー + クォータで要件を満たせる。コードは学習成果として `album-guard/` に凍結保存 |
| Cloudflare Tunnel で Immich を公開 | 無料プランの 100MB リクエスト上限 × Immich にチャンクアップロード無し → スマホ動画のバックアップが壊れる(2026-08 検証)。公開面の攻撃リスクも増える。窓口は tus で分割するため、Funnel が不合格のときの代替候補には残る(ルール変更が必要) |
| Immich 標準の共有リンクでゲストに直接アップロードさせる | Immich 本体を公開する必要がある。投稿者名の記録・ゲスト自身の削除も無い(比較は [guest-gateway.md](guest-gateway.md)) |
| NAS | 普及帯 NAS は CPU が弱く Immich の ML に不向き。NFS のランダム IOPS はローカルの数百分の一 |
| RAID / バックアップドライブ | 「一時置き場」の設計方針に対して過剰投資。クォータと容量監視で運用する |

## データ配置

| データ | 場所 | FS | 理由 |
|---|---|---|---|
| 写真原本(`upload/` `library/` `profile/`) | `/mnt/photo/immich-library`(`UPLOAD_LOCATION`) | Btrfs | scrub で劣化検知、大容量 HDD |
| サムネイル・変換動画 | 同上(再生成可能) | Btrfs | 容量が大きいだけで消えても再生成可 |
| Postgres データ | `/srv/photosaver/postgres` | ext4 (NVMe) | 公式要件: ローカル SSD、CoW 回避 |
| DB ダンプ | `/mnt/photo/.../backups/` + NVMe ミラー | 両方 | 唯一の多重化データ |
| compose / .env | `/srv/photosaver/` | ext4 (NVMe) | リポジトリ `server/` からコピー |
| 窓口のアップロード途中のファイル | `/mnt/photo/guest-gateway/staging` | Btrfs | 大きな動画を受けるため HDD。システムディスクには書かない |
| 窓口の .env・取り込み記録(sqlite)・Tailscale 状態 | `/srv/photosaver/guest-gateway/` | ext4 (NVMe) | 小さい。イベント終了後に削除 |

HDD のマウント確認用マーカーは 2 つ必要:

- `/mnt/photo/immich-library/.photosaver.mount-ok` — Immich の mount-guard が確認(`${UPLOAD_LOCATION}` 直下)
- `/mnt/photo/.photosaver.mount-ok` — guest-gateway が起動時と各アップロード受付前に確認

## 関連ドキュメント

- 機材と選定理由: [hardware.md](hardware.md)
- セットアップ手順: [new-server-setup.md](new-server-setup.md)
- 移行手順: [migration-runbook.md](migration-runbook.md)
- 日常運用: [operations.md](operations.md)
- Tailscale 詳細: [tailscale.md](tailscale.md)
- ゲスト用アップロード窓口: [guest-gateway.md](guest-gateway.md)
- 旧設計(album-guard 時代)の資料: [legacy/](legacy/)
