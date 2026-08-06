# 移行ランブック: Windows 検証環境 → 新 Linux サーバー

旧環境(Windows + Docker Desktop + `E:/Photo`)から新ミニ PC へ Immich のデータを
移す手順。**移行しない(新規で始める)場合はこのドキュメントは不要** —
検証環境のデータを捨てて [new-server-setup.md](new-server-setup.md) の手順 9 で新規構築すればよい。

> 原則(公式): リストアは**ダンプを取った Immich と同一バージョン**の
> **完全に新規の**スタックに対して行う。ダウングレードは不可。
> 参照: [Backup and Restore](https://docs.immich.app/administration/backup-and-restore)

## Phase 0 — 旧環境(Windows)側の準備

1. スタックを最新化してバージョンを揃える:
   ```powershell
   cd immich
   docker compose pull
   docker compose up -d
   ```
2. ブラウザで管理画面 → **サーバー情報でバージョンを記録**(例: v3.1.0)
3. **管理 → サーバー統計 でユーザー別アセット数を記録**(移行後の検証に使う)
4. 管理 → ジョブ → **「データベースダンプを作成」を実行**
   (`E:/Photo/immich-library/backups/` に `.sql.gz` ができる)

> **注意**: PowerShell の `>` リダイレクトで手動 pg_dump を取ると UTF-16 になり
> リストアに失敗する既知の罠がある。**必ず上記の管理画面からのダンプを使う**
> (コンテナ内で生成されるためエンコーディング問題が起きない)。

## Phase 1 — 停止とエクスポート

1. アップロードが走っていないことを確認してから停止:
   ```powershell
   docker compose stop immich-server immich-machine-learning
   ```
2. コピー対象は `E:/Photo/immich-library/` 以下の全部:
   - **必須**: `upload/`, `library/`, `profile/`, `backups/`
   - **再生成可能**(コピーすれば数時間の再処理を節約): `thumbs/`, `encoded-video/`
3. Windows マシンをシャットダウンし、外付けドライブを取り外す

## Phase 2 — ファイル転送(NTFS → Btrfs)

新サーバーに旧外付けドライブを直挿しするのが最速・最簡単
(Linux の NTFS **読み取り**は kernel ドライバで安定している):

```bash
sudo mkdir -p /mnt/ntfs
sudo mount -t ntfs3 -o ro /dev/sdb2 /mnt/ntfs    # デバイスは lsblk で確認
rsync -a --info=progress2 /mnt/ntfs/Photo/immich-library/ /mnt/photo/immich-library/
sudo umount /mnt/ntfs
```

`rsync -a` でタイムスタンプが保持される(Immich のメタデータは DB 側にあるが、
将来のツール互換のため保持しておく)。

## Phase 3 — 新サーバーでリストア

前提: [new-server-setup.md](new-server-setup.md) の手順 8 の途中
(`.env` 作成まで完了、**まだ `docker compose up` していない**)。

1. `.env` の `IMMICH_VERSION` を **Phase 0 で記録した完全一致バージョン**に固定する
   (例: `IMMICH_VERSION=v3.1.0`)
2. 起動:
   ```bash
   docker compose up -d
   ```
3. ブラウザで開くと初期画面に **「バックアップから復元 (Restore from backup)」** が
   表示される。`backups/` 内の最新ダンプを選んで復元する
   (Immich が `UPLOAD_LOCATION/backups/` を自動検出する)
4. 復元後の初回起動は `clip_index` / `face_index` の再インデックスでしばらく重い(正常)。
   **CLIP・顔認識の埋め込みはダンプに含まれるため ML ジョブの再実行は不要**

### パスに関する確認(重要)

旧環境の compose はコンテナ内マウントが `/usr/src/app/upload`(旧仕様)、
新 compose は `/data`(現行仕様)。Immich には旧パスから `/data` への
**自動マイグレーション**があるため通常はそのまま動くが、必ず検証すること:

- タイムラインのサムネイルが表示され、**写真を開いて原本がダウンロードできる**か
- ダメな場合(404 が出る場合)の退避策: `docker-compose.yml` の immich-server に
  旧パスのマウントを追加して再起動
  ```yaml
      - ${UPLOAD_LOCATION}:/usr/src/app/upload
  ```

## Phase 4 — 検証と切替完了

- [ ] ユーザー別アセット数が Phase 0 の記録と一致(管理 → サーバー統計)
- [ ] タイムライン・アルバム・ピープル・スマート検索が機能する
- [ ] 管理 → メンテナンス(Repair)で orphaned / untracked が異常な数になっていない
- [ ] スマホの Immich アプリから ts.net URL でログインできる
- [ ] 問題なければ `.env` の固定を `IMMICH_VERSION=v3` に戻して
  `docker compose up -d`(以後は v3 系最新に追従)
- [ ] [new-server-setup.md](new-server-setup.md) 手順 9 以降(テンプレート確認・
  クォータ・友達招待)を実施

## 旧フォルダ写真の一括投入(任意)

昔の写真フォルダ(他のドライブ等)をまとめて入れる場合は **immich CLI** を使う
(重複はハッシュで自動スキップされるので再実行も安全):

```bash
npm i -g @immich/cli
immich login https://photosaver.<tailnet>.ts.net <APIキー>   # APIキーはアカウント設定から発行
immich upload --recursive --album-name "旧アーカイブ" /path/to/old-photos --dry-run
immich upload --recursive --album-name "旧アーカイブ" /path/to/old-photos
```

External Library 機能は「元のフォルダ構造のまま管理し続けたい」場合専用であり、
ドライブを退役させる今回の用途には CLI アップロードが正しい。

## 移行後の後片付け

- 旧 64GB USB ドライブは初期化して自由に転用してよい
- Windows 側の Docker Desktop スタックは `docker compose down` で削除
  (named volume `immich-postgres` も不要になるが、`down -v` は移行検証完了後にのみ実行)
