# 運用手順(Photosaver v2)

新サーバー(Ubuntu ミニ PC)の日常運用。セットアップは [new-server-setup.md](new-server-setup.md)。

## 日常: やることは基本ない

- 自動で動いているもの: OS のセキュリティ自動更新(docker 除外・04:00 自動再起動)、
  Immich の日次 DB ダンプ(02:00)、DB ダンプの NVMe ミラー(03:00 cron)、
  Btrfs 月次 scrub
- コンテナは `restart: always` で電源断・再起動から自動復帰する

## 月次: Immich アップデート(15 分)

Immich はスマホアプリが自動更新される一方、**サーバーは自分のメジャーと同じ
アプリまでしかサポートしない**。放置するとある日友達のアプリが
「サーバーのバージョンが古い」エラーで使えなくなるため、**月 1 回の更新を習慣化**する。

```bash
cd /srv/photosaver
# 1. リリースノート確認(重大な変更が告知されていないか)
#    https://github.com/immich-app/immich/releases
# 2. 念のため DB ダンプを先に取る(管理画面 → ジョブ → データベースダンプ作成)
# 3. 更新
docker compose pull
docker compose up -d
docker compose ps    # healthy 確認
```

- `.env` は `IMMICH_VERSION=v3` なので v3 系の範囲で安全に追従する
- **v4 が出たら**: リリースノートと移行ガイドを読んでから `.env` を `v4` に上げる。
  順序は「スマホアプリが先・サーバーが後」
- **自動更新ツール(Watchtower 等)は使わない**(Watchtower は開発終了。
  Immich のバージョン整合モデルとも相性が悪い)。更新通知だけ欲しければ
  [GitHub リリースの Atom フィード](https://github.com/immich-app/immich/releases.atom) を購読

## compose 設定の反映(リポジトリの `server/` を変更したとき)

本番の compose は `/srv/photosaver/` に**コピーして**使っている(new-server-setup.md 手順 8)。
リポジトリ側の `server/docker-compose.yml` が更新されたら、差分を確認してから反映する:

```bash
git -C /srv/photosaver/repo pull --ff-only
diff /srv/photosaver/docker-compose.yml /srv/photosaver/repo/server/docker-compose.yml   # 何が変わるか確認
cp /srv/photosaver/repo/server/docker-compose.yml /srv/photosaver/
cd /srv/photosaver && docker compose up -d    # 変更のあったサービスだけ作り直される(数十秒止まる)
docker compose ps                             # healthy 確認
```

- `.env` と `hwaccel.*.yml` はコピーしない(サーバー固有)。`server/.env.example` に新しい変数が
  増えていたら、`diff` で確認して `.env` に手で追記する
- `server/scripts/` が変わっていたら同様に `cp` する
- 内部ネットワーク `photosaver_gw`(guest-gateway 用、差分 5)はこの compose が作る。窓口が動いている間は
  Immich 側を `docker compose down` しても残るが、窓口が止まっていれば消える。窓口は必ず Immich の
  **後に**起動する(先に起動すると `photosaver_gw ... could not be found` で失敗する)。
  反映後の確認: `docker network inspect photosaver_gw --format '{{.Internal}} {{range .Containers}}{{.Name}} {{end}}'`
  → `true immich_server`(窓口が動いていれば `guest_gateway_ts` も並ぶ)

## 容量管理

```bash
df -h /mnt/photo          # HDD 使用率
docker system df          # Docker 側の肥大確認
```

- **使用率 80% を超えたら**: 大容量 HDD への移行を計画する(下記)
- **満杯になると**: Immich は動作停止し、途中アップロードの一時ファイルが
  容量を占有し続ける(コンテナ再起動で解放)。満杯にさせないことが最重要
- 一次防衛は**ユーザーごとのクォータ**(管理 → ユーザー)。
  クォータ合計 ≦ HDD 容量の 8 割 を維持する

### HDD 増設・交換の手順(概要)

1. 新 HDD を Btrfs でフォーマット(new-server-setup.md 手順 6 と同様)し、仮の場所(例: `/mnt/photo-new`)にマウント
2. 窓口が動いていれば `docker compose -p wedding-gw down`、Immich は `docker compose stop`
3. `rsync -a --info=progress2 /mnt/photo/ /mnt/photo-new/`(`/mnt/photo` 以下を丸ごと。マーカー 2 つも一緒にコピーされる)
4. fstab の UUID を差し替え、`/mnt/photo` に新 HDD をマウント
5. マーカー 2 つがあることを確認し、無ければ作る:
   ```bash
   ls -la /mnt/photo/.photosaver.mount-ok /mnt/photo/immich-library/.photosaver.mount-ok
   # 無い場合のみ。HDD がマウントされていることを確かめてから作る
   findmnt /mnt/photo >/dev/null && touch /mnt/photo/.photosaver.mount-ok /mnt/photo/immich-library/.photosaver.mount-ok
   ```
   (`/mnt/photo/` 直下は guest-gateway 用、`immich-library/` 直下は mount-guard 用。後者が無いと Immich は起動しない)
6. scrub タイマーはマウント先のパスで決まるので、`/mnt/photo` のままなら設定し直し不要
7. `docker compose up -d` → 動作確認後、旧 HDD は退役

## イベント用の窓口(guest-gateway)

イベント時だけ別の compose プロジェクト `wedding-gw` で動かす。当日の手順・監視・問い合わせ対応は
[guest-gateway.md の「当日の運用」](guest-gateway.md#当日の運用)、デプロイは
[guest-gateway/README.md](../guest-gateway/README.md) を参照。

- 緊急停止: `docker compose -p wedding-gw down`(tailnet 内の Immich はそのまま使える)
- ⚠️ ミニ PC 本体で `tailscale funnel reset` / `tailscale serve reset` は**使わない**
  (Immich の tailnet 公開まで消える)
- 起動順は Immich → 窓口(上の「compose 設定の反映」参照)

## ユーザー管理

- 追加: 管理 → ユーザー → 作成。**クォータとストレージラベルを必ず設定**
- 削除: ユーザー削除には 7 日間の猶予期間がある(誤削除の取り消し可)
- 友達のオンボーディング手順: [new-server-setup.md](new-server-setup.md) 手順 10

## 健全性チェック(気が向いたときに)

```bash
docker compose ps                              # 全サービス healthy?
ls /mnt/photo/.photosaver.mount-ok /mnt/photo/immich-library/.photosaver.mount-ok   # HDD マウント済み?
tailscale serve status                         # 443 → 2283 転送が生きてる?
sudo btrfs scrub status /mnt/photo             # 直近 scrub でエラー 0?
sudo smartctl -H /dev/sda                      # HDD の SMART 健康状態
ls -lt /srv/photosaver/db-dumps | head -3      # DB ダンプミラーが更新されてる?
```

scrub がエラーを報告した場合: 該当ファイルは壊れている(修復用の複製は無い)。
管理画面のアセットから特定して削除し、HDD の SMART を確認。エラーが続くなら
HDD 交換のサイン。

## トラブルシューティング

| 症状 | 最初に見るところ |
|---|---|
| 友達「写真が上がらない」 | ①友達のスマホの Tailscale がオンか ②クォータ超過(管理→サーバー統計)③サーバー稼働(`docker compose ps`) |
| ts.net URL で繋がらない | `tailscale status`、`tailscale serve status`。Machines 画面で key expiry が切れていないか |
| Immich が起動しない(`docker compose logs mount-guard` に `FATAL: photo drive not mounted`) | `lsblk` で HDD 認識確認 → `sudo mount -a` → `/mnt/photo/immich-library/.photosaver.mount-ok` の存在確認(mount-guard が見るのはこちら)→ `docker compose up -d` |
| guest-gateway が起動しない・受付が止まる | `/mnt/photo/.photosaver.mount-ok` の存在確認(窓口が見るのはこちら)。詳細は [guest-gateway.md](guest-gateway.md#困ったとき) |
| Web が 500/真っ白 | `docker compose logs -f immich-server`。DB unhealthy なら `docker compose logs database` |
| ML/検索が重い・落ちる | ML はバッチ処理なので一時停止可: 管理 → ジョブ で Smart Search を一時停止 |
| アプリ「サーバーが古い」 | 月次更新を実施(上記) |
| 電源断のあと起動しない | BIOS の AC Recovery = Power On を再確認。fstab に `nofail` があれば HDD 障害でも OS は起動する |

## 障害シナリオと復旧

| 障害 | 影響 | 復旧 |
|---|---|---|
| HDD 故障 | **写真原本は喪失**(設計上許容済み) | 新 HDD で新規構築。NVMe 上の DB ダンプで「何があったか」は確認できる |
| NVMe 故障 | DB 喪失、写真原本は無事 | OS 再構築(セットアップ手順 6 は**フォーマットせず** fstab 追記とマウントだけ)→ HDD 上の `backups/` 最新ダンプでリストア([migration-runbook.md](migration-runbook.md) Phase 3 と同手順)→ サムネイル再生成 |
| ミニ PC 故障 | ハード交換まで停止 | HDD を新機体に挿してセットアップ手順を再実行(手順 6 の `wipefs` / `mkfs` は**実行しない**。マーカー 2 つは HDD 上に残っている)。データは HDD + ダンプで復元 |
| 誤操作で DB 破損 | メタデータ喪失リスク | 管理 → メンテナンス → 「バックアップから復元」(復元ポイント自動作成・失敗時ロールバック付き) |

## 旧環境(Windows 検証環境)について

`immich/` ディレクトリの Windows + album-guard スタックは凍結済み。
起動したい場合のみ旧ドキュメント([legacy/](legacy/))を参照。
