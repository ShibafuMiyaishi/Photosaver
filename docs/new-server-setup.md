# 新サーバー セットアップ手順(ゼロから完成まで)

中古ミニ PC(OptiPlex 7070 Micro 想定)を開封してから、友達がスマホで写真を
アップロードできるようになるまでの全手順。所要 2〜4 時間(ML ジョブ除く)。

前提機材: [hardware.md](hardware.md) / 完成形の構成: [architecture.md](architecture.md) /
旧環境からのデータ移行: [migration-runbook.md](migration-runbook.md)

---

## 1. BIOS 設定(Dell は起動時 F2)

24 時間稼働サーバー向けに以下を変更する:

| 設定 | 値 | 理由 |
|---|---|---|
| Power Management → AC Recovery | **Power On** | 停電復帰後に自動起動 |
| Power Management → Deep Sleep Control | Disabled | Wake 系機能の阻害を防ぐ |
| Power Management → USB Wake Support | Enabled(任意) | |
| Virtualization | Enabled(通常デフォルト) | Docker に必要 |
| SupportAssist / 診断系の自動実行 | Disabled(任意) | 起動時間短縮 |

Secure Boot は有効のままで問題ない(Ubuntu は署名済みカーネルで起動する)。

## 2. Ubuntu Server 24.04 LTS インストール

1. 別の PC で [Ubuntu Server 24.04 LTS ISO](https://ubuntu.com/download/server) を取得し、
   [Rufus](https://rufus.ie/) 等で USB メモリに書き込む
2. ミニ PC に USB を挿して起動(F12 でブートメニュー)
3. インストーラの選択:
   - **Ubuntu Server(minimized ではない方)**を選択
   - ストレージ: 内蔵 NVMe に「ディスク全体を使用」(ext4、LVM はどちらでも可)。
     Windows ライセンスは消えるが本用途では不要
   - プロファイル: ユーザー名は任意(例: `photosaver`)、サーバー名例: `photosaver`
   - **OpenSSH server にチェックを入れる**
   - **Featured Server Snaps では何も選ばない(特に Docker を選ばない)**
     — snap 版 Docker は避け、後で公式 apt リポジトリから入れる
4. 再起動後、ルーターの管理画面でこのマシンの **DHCP 固定割当(IP 予約)** を設定する

## 3. 初期設定と自動セキュリティ更新

SSH で入る(`ssh photosaver@<IP>`)か本体にキーボードを繋いで:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo timedatectl set-timezone Asia/Tokyo

# 自動セキュリティ更新の調整
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # 「はい」を選択
```

`/etc/apt/apt.conf.d/50unattended-upgrades` を編集して 3 点変更:

```
// 1) security ポケットのみ有効(-updates はコメントアウトのまま)

// 2) Docker を自動更新から除外(自動更新は全コンテナを深夜に再起動させるため)
Unattended-Upgrade::Package-Blacklist {
    "docker-ce";
    "docker-ce-cli";
    "containerd.io";
    "docker-compose-plugin";
};

// 3) カーネル更新を反映するための自動再起動(compose の restart:always で復帰する)
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
```

## 4. SSH 硬化

```bash
# 手元 PC で鍵を作りサーバーへ登録(手元 PC 側で実行)
ssh-keygen -t ed25519
ssh-copy-id photosaver@<IP>

# サーバー側: パスワード認証と root ログインを無効化
sudo nano /etc/ssh/sshd_config.d/hardening.conf
```

```
PasswordAuthentication no
PermitRootLogin no
```

```bash
sudo systemctl restart ssh

# ファイアウォール(Tailscale 導入後は SSH も tailnet 経由になるが、初期は LAN 許可)
sudo ufw allow ssh
sudo ufw enable
```

## 5. Docker Engine(公式 apt リポジトリ)

[公式手順](https://docs.docker.com/engine/install/ubuntu/) の通り:

```bash
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable docker
sudo usermod -aG docker $USER   # 再ログインで反映
```

Docker Desktop は入れない(Linux では VM 経由になり、Immich 公式も非推奨)。

## 6. 写真用 HDD の準備(Btrfs + UUID マウント)

外付け HDD を接続して:

```bash
lsblk                          # デバイス名確認(例: /dev/sda)
sudo wipefs -a /dev/sda        # 既存パーティション情報を消去(対象を必ず確認!)
sudo mkfs.btrfs -L photo /dev/sda
sudo mkdir -p /mnt/photo
sudo blkid /dev/sda            # UUID をメモ
```

`/etc/fstab` に追記(**UUID 指定 + nofail が必須**。デバイス名は接続順で変わる):

```
UUID=<メモした UUID>  /mnt/photo  btrfs  defaults,noatime,nofail  0  0
```

```bash
sudo systemctl daemon-reload && sudo mount -a
findmnt /mnt/photo    # HDD がマウントされていることを確認(何も出なければここで止める)

# 以下は HDD がマウントされているときだけ実行される(システムディスク側に書かないため)
# HDD 直下のマウント確認用マーカー(guest-gateway と、運用時の「HDD はマウントされているか」確認が使う)
findmnt /mnt/photo >/dev/null && sudo chown $USER:$USER /mnt/photo && touch /mnt/photo/.photosaver.mount-ok

# 月次 scrub(ビット腐敗検知)を有効化
sudo systemctl enable --now btrfs-scrub@$(systemd-escape -p /mnt/photo).timer
```

> **なぜマーカーファイルか**: HDD が外れた状態で Docker が起動すると、bind mount は
> システムディスク上の空のディレクトリを掴んで Immich がそこに書き込んでしまう
> (壊れたアセットが生まれる)。マーカーは HDD 上にしか無いので、未マウントなら起動を止められる。
> マーカーは 2 つある:
>
> | ファイル | 読むもの | 作る手順 |
> |---|---|---|
> | `/mnt/photo/.photosaver.mount-ok` | guest-gateway(無いと起動・受付しない)、手動の確認 | この手順 6 |
> | `/mnt/photo/immich-library/.photosaver.mount-ok` | compose の `mount-guard`(`UPLOAD_LOCATION` を見る。無いと Immich が起動しない) | 手順 8 |

### Docker の起動を HDD マウントの後にする(systemd drop-in)

OS 起動時、Docker は `restart: always` のコンテナを**自分で**再起動する。このとき compose の
`depends_on` は使われないため **mount-guard は走らない**。さらに `nofail` の HDD は起動の待ち合わせ
対象から外れる(`local-fs.target` の前に並ばない)ので、Docker が HDD のマウントより先に起動しうる。
その場合 immich-server の bind mount はシステムディスク上に空の `/mnt/photo/immich-library` を作って掴む。
これを防ぐため、Docker の起動を `/mnt/photo` のマウント処理の後に並べる:

```bash
systemd-escape -p --suffix=mount /mnt/photo     # → mnt-photo.mount(fstab から自動生成されるユニット名)
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nAfter=mnt-photo.mount\n' | sudo tee /etc/systemd/system/docker.service.d/photosaver-mount.conf
sudo systemctl daemon-reload                    # Docker の再起動は不要(次回起動から効く)
systemctl show docker -p After | tr ' ' '\n' | grep -x mnt-photo.mount   # 1 行出れば OK
```

- `After=` は**順序だけ**の指定。起動時に `mnt-photo.mount` のマウント処理が走っていれば、それが
  **成功か失敗で終わるまで** Docker の起動を待たせる。HDD が認識されない場合はデバイス待ちの
  タイムアウト(既定で 90 秒程度)の後にマウントが失敗し、Docker はそのまま起動する
  (終了時は逆順になり、Docker が止まってからアンマウントされる)
- `Requires=` / `RequiresMountsFor=` は**使わない**。これらはマウント失敗時に Docker 自体を起動させない
  (`RequiresMountsFor=` は `Requires=` + `After=` と同じ)。HDD が壊れても OS・Docker・SSH は動いて
  いてほしい(DB ダンプの確認や復旧作業のため)ので、順序付けだけにする
- それでも HDD が無いまま Docker が起動した場合の第 2 の防御は Immich 自身の起動時チェック
  ([System Integrity](https://docs.immich.app/administration/system-integrity)):
  一度正常に起動した Immich は、各メディアフォルダの `.immich` ファイルが読めないと
  起動を中止する(`Failed to read: ...` を出して終了 → `restart: always` で再起動を繰り返す)。
  写真がシステムディスクに書かれることはないが、Immich は HDD を戻すまで使えない。
  空の `/mnt/photo/immich-library` はシステムディスク側に残るが、HDD を再マウントすれば隠れて無害。
  (挙動は Immich v3.2.4 のソースで確認。実機での再現は未確認)

## 7. Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up          # 表示された URL をブラウザで開いて認証
```

[Tailscale 管理画面](https://login.tailscale.com/admin) で:

1. **DNS → MagicDNS を有効化**、**HTTPS Certificates を有効化**
2. Machines → このマシンの **Key expiry を Disable** にする(期限切れで突然死しないように)

HTTPS 公開(Immich 起動後でもよい):

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:2283
tailscale serve status     # 確認
```

`--bg` の設定は**再起動後も永続する**(公式仕様)。URL は
`https://photosaver.<tailnet名>.ts.net` になる(`tailscale status` で確認)。

Immich は tailnet 内だけに公開する(Funnel・Cloudflare Tunnel・ルーターのポート開放はしない)。
イベント用の guest-gateway は別ノードで公開するため、**このホストで `tailscale funnel reset` /
`tailscale serve reset` は実行しない**(Immich の公開設定まで消える)。詳細は [tailscale.md](tailscale.md)。

## 8. Immich デプロイ

```bash
sudo mkdir -p /srv/photosaver && sudo chown $USER:$USER /srv/photosaver
cd /srv/photosaver
git clone https://github.com/ShibafuMiyaishi/Photosaver.git repo
cp -r repo/server/. /srv/photosaver/   # compose 一式を配置(`.env.example` も含めるため `*` ではなく `.`)

# QSV 用の公式 hwaccel 定義を取得(compose の extends が参照する。無いと起動できない)
curl -LO https://github.com/immich-app/immich/releases/latest/download/hwaccel.transcoding.yml
curl -LO https://github.com/immich-app/immich/releases/latest/download/hwaccel.ml.yml

cp .env.example .env
chmod 600 .env
nano .env    # DB_PASSWORD を生成して設定(openssl rand -hex 24)。他は既定値のままでよい

# 写真ライブラリ(HDD)と mount-guard 用マーカー。マーカーが無いと Immich は起動しない
# (HDD マウント済みのときだけ作る。未マウントならどれも実行されない)
test -f /mnt/photo/.photosaver.mount-ok && mkdir -p /mnt/photo/immich-library \
  && touch /mnt/photo/immich-library/.photosaver.mount-ok

docker compose up -d
docker compose ps        # 全サービス healthy になるまで待つ(初回は数分)
```

`.env` の既定値の意味(変更しない):

- `IMMICH_VERSION=v3` — v3 系のメジャー固定メタタグ。`release` / `latest` にはしない
- `UPLOAD_LOCATION=/mnt/photo/immich-library` — 写真原本(HDD)
- `DB_DATA_LOCATION=/srv/photosaver/postgres` — Postgres は**内蔵 NVMe(ext4)**。
  HDD・Btrfs・NTFS/exFAT・ネットワーク共有には置かない(公式要件)

`server/docker-compose.yml` は公式 compose からの差分 5 点(127.0.0.1 バインド、mount-guard、
QSV、`DB_STORAGE_TYPE` 未設定、guest-gateway 用内部ネットワーク `photosaver_gw`)をヘッダーに
列挙している。`photosaver_gw` はこの `docker compose up` で作られる(guest-gateway を使わなければ何もしない)。

> 旧環境からデータを移行する場合は、**`docker compose up -d` の前で止めて**
> [migration-runbook.md](migration-runbook.md) に従うこと(初回起動前に `backups/` を配置するとリストア画面が使える)。

## 9. Immich 初期設定(ブラウザで https://<ts.net の URL>)

新規構築の場合(移行の場合はランブック側の手順が優先):

1. 管理者アカウントを作成
2. **管理 → 設定 → ストレージテンプレート**: 有効化し、テンプレートを
   `{{y}}/{{MM}}/{{filename}}` に設定(**友達が使い始める前に必ず**。
   後から変えると全ファイル移動ジョブが走る)
3. **管理 → 設定 → 動画トランスコード**: ハードウェアアクセラレーション =
   **Quick Sync** を選択(compose 側の設定だけでは有効にならない。両方必要)
4. **管理 → 設定 → バックアップ**: DB 自動ダンプが有効(毎日 02:00 / 14 世代)なことを確認
5. **管理 → ユーザー**: 家族・友達のアカウントを作成
   - **ストレージクォータを必ず設定**(例: 友達 100〜300GB。合計が HDD の 8 割以下)
   - **ストレージラベル**も設定(HDD 上のフォルダ名が UUID でなく名前になる)

DB ダンプの NVMe ミラー(任意だが推奨、無料):

```bash
chmod +x /srv/photosaver/scripts/sync-db-dumps.sh
crontab -e
# 追記: 0 3 * * * /srv/photosaver/scripts/sync-db-dumps.sh >> /var/tmp/photosaver-dbsync.log 2>&1
```

スクリプトは `rsync --delete` でミラーするため、HDD 未マウント時にミラーまで空にしないよう、
`immich-library/.photosaver.mount-ok` が無いとき・`backups/` に `immich-db-backup-*.sql.gz` が
1 つも無いときは**何もせずエラー終了**する(ログに `ERROR: ... ミラーは変更しない` が出る)。
初回の DB ダンプ(02:00)より前に動いた回はこのエラーになるが無害。

## 10. 友達の招待手順(node sharing — 無料枠を消費しない)

自分の tailnet に「ユーザー」として招待すると無料枠(6人)を使うが、
**マシン共有(node sharing)なら人数無制限・双方無料**。

1. [Tailscale 管理画面](https://login.tailscale.com/admin/machines) → photosaver マシンの
   [...] → **Share** → 招待リンクを作成して友達に送る
2. 友達側の作業:
   1. Tailscale アプリをインストールし、Google/Apple 等でアカウント作成(無料)
   2. 招待リンクを開いて共有を承認
   3. Tailscale アプリで VPN を**オンのままにする**
   4. Immich アプリをインストールし、サーバー URL に
      `https://photosaver.<tailnet名>.ts.net` を入力(**フル FQDN 必須**。短縮名は不可)
   5. こちらで発行したアカウントでログイン
   6. バックアップを有効化する場合: 対象アルバム選択 +
      (iOS)設定 → Background App Refresh オン /
      (Android)電池の最適化から Immich と Tailscale を除外

**友達に伝えておくこと**(重要な期待値調整):

- 自動バックアップはベストエフォート。**ときどき Immich アプリを開くと確実**
  (iOS は OS の制約、Android は一部端末で Tailscale 併用時の既知の不具合がある)
- 「写真が上がらない」時の最初の確認は **Tailscale が オン になっているか**
- このサーバーは一時共有置き場。**残したい写真は各自の端末に保存すること**
  (サーバーの HDD が壊れたら写真は戻らない運用)

## 11. 完成チェックリスト

- [ ] 再起動テスト: `sudo reboot` 後、何も操作せず Immich にアクセスできる
- [ ] Docker が HDD マウントの後に起動する設定: `systemctl show docker -p After | tr ' ' '\n' | grep -x mnt-photo.mount` が 1 行出る(手順 6)
- [ ] マーカー 2 つが存在する: `ls -la /mnt/photo/.photosaver.mount-ok /mnt/photo/immich-library/.photosaver.mount-ok`
- [ ] HDD 抜きテスト: `docker compose down` → `sudo umount /mnt/photo` → `docker compose up -d` で
  `docker compose logs mount-guard` に `FATAL: photo drive not mounted` が出て immich-server が起動しない
  → `sudo mount -a` → `docker compose up -d` で復帰(未マウント中に Docker がシステムディスク側に
  空の `immich-library` を作るが、再マウントで隠れるので無害)
- [ ] `docker compose ps` で全サービス healthy、`.env` が `IMMICH_VERSION=v3`
- [ ] `df -T /srv/photosaver/postgres` が内蔵 NVMe の ext4 を指している
- [ ] `docker network inspect photosaver_gw --format '{{.Internal}}'` が `true`(immich-server だけが参加)
- [ ] スマホの Immich アプリから写真をアップロードできる(Wi-Fi とモバイル回線の両方)
- [ ] `tailscale serve status` で 443 → 2283 の転送が生きている
- [ ] 管理画面 → ジョブ でサムネイル生成が完走している
- [ ] クォータ設定済みユーザーでアップロードできる
- [ ] `df -h /mnt/photo` で容量を把握(80% 超えたら [operations.md](operations.md) の増設手順へ)

日々の運用(月次アップデート、容量管理、トラブル対応)は [operations.md](operations.md) へ。
