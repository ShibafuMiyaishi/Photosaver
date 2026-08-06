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

1. 新 HDD を Btrfs でフォーマット(new-server-setup.md 手順 6 と同様)
2. `docker compose stop` → 旧 HDD から新 HDD へ `rsync -a`
3. fstab の UUID を差し替え、`/mnt/photo` に新 HDD をマウント
4. マーカーファイル `touch /mnt/photo/.photosaver.mount-ok` を忘れずに
5. `docker compose up -d` → 動作確認後、旧 HDD は退役

## ユーザー管理

- 追加: 管理 → ユーザー → 作成。**クォータとストレージラベルを必ず設定**
- 削除: ユーザー削除には 7 日間の猶予期間がある(誤削除の取り消し可)
- 友達のオンボーディング手順: [new-server-setup.md](new-server-setup.md) 手順 10

## 健全性チェック(気が向いたときに)

```bash
docker compose ps                              # 全サービス healthy?
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
| mount-guard が起動を止める | `lsblk` で HDD 認識確認 → `sudo mount -a` → マーカーファイル存在確認 |
| Web が 500/真っ白 | `docker compose logs -f immich-server`。DB unhealthy なら `docker compose logs database` |
| ML/検索が重い・落ちる | ML はバッチ処理なので一時停止可: 管理 → ジョブ で Smart Search を一時停止 |
| アプリ「サーバーが古い」 | 月次更新を実施(上記) |
| 電源断のあと起動しない | BIOS の AC Recovery = Power On を再確認。fstab に `nofail` があれば HDD 障害でも OS は起動する |

## 障害シナリオと復旧

| 障害 | 影響 | 復旧 |
|---|---|---|
| HDD 故障 | **写真原本は喪失**(設計上許容済み) | 新 HDD で新規構築。NVMe 上の DB ダンプで「何があったか」は確認できる |
| NVMe 故障 | DB 喪失、写真原本は無事 | OS 再構築 → HDD 上の `backups/` 最新ダンプでリストア([migration-runbook.md](migration-runbook.md) Phase 3 と同手順)→ サムネイル再生成 |
| ミニ PC 故障 | ハード交換まで停止 | HDD を新機体に挿してセットアップ手順を再実行。データは HDD + ダンプで復元 |
| 誤操作で DB 破損 | メタデータ喪失リスク | 管理 → メンテナンス → 「バックアップから復元」(復元ポイント自動作成・失敗時ロールバック付き) |

## 旧環境(Windows 検証環境)について

`immich/` ディレクトリの Windows + album-guard スタックは凍結済み。
起動したい場合のみ旧ドキュメント([legacy/](legacy/))を参照。
