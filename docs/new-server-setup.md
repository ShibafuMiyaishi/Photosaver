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
sudo chown $USER:$USER /mnt/photo

# マウント検証用マーカーファイル(compose の mount-guard が確認する)
touch /mnt/photo/.photosaver.mount-ok

# 月次 scrub(ビット腐敗検知)を有効化
sudo systemctl enable --now btrfs-scrub@$(systemd-escape -p /mnt/photo).timer
```

> **なぜマーカーファイルか**: HDD が外れた状態で Docker が起動すると、bind mount は
> 空の `/mnt/photo` ディレクトリを掴んで Immich がそこに書き込んでしまう
> (壊れたアセットが生まれる)。マーカーは HDD 上にあるので、未マウントなら
> mount-guard が失敗してスタック全体の起動が止まる。

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

## 8. Immich デプロイ

```bash
sudo mkdir -p /srv/photosaver && sudo chown $USER:$USER /srv/photosaver
cd /srv/photosaver
git clone https://github.com/ShibafuMiyaishi/Photosaver.git repo
cp -r repo/server/* /srv/photosaver/    # compose 一式を配置
cd /srv/photosaver

# QSV 用の公式 hwaccel 定義を取得(compose が参照する)
curl -LO https://github.com/immich-app/immich/releases/latest/download/hwaccel.transcoding.yml
curl -LO https://github.com/immich-app/immich/releases/latest/download/hwaccel.ml.yml

cp .env.example .env
nano .env    # DB_PASSWORD を生成して設定(openssl rand -hex 24)
mkdir -p /mnt/photo/immich-library

docker compose up -d
docker compose ps        # 全サービス healthy になるまで待つ(初回は数分)
```

> 旧環境からデータを移行する場合は、**ここで止めて** [migration-runbook.md](migration-runbook.md)
> に従うこと(初回起動前に `backups/` を配置するとリストア画面が使える)。

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
- [ ] HDD 抜きテスト: HDD を外して `docker compose up -d` → mount-guard が起動を止める
- [ ] スマホの Immich アプリから写真をアップロードできる(Wi-Fi とモバイル回線の両方)
- [ ] `tailscale serve status` で 443 → 2283 の転送が生きている
- [ ] 管理画面 → ジョブ でサムネイル生成が完走している
- [ ] クォータ設定済みユーザーでアップロードできる
- [ ] `df -h /mnt/photo` で容量を把握(80% 超えたら [operations.md](operations.md) の増設手順へ)

日々の運用(月次アップデート、容量管理、トラブル対応)は [operations.md](operations.md) へ。
