# 外付けドライブ運用

HPSS は **写真データを外付けドライブに保存する設計**。本書はその運用指針と注意事項。

## 設計原則

- **コードと写真データは物理的に分離**
- ドライブのパスは **設定ファイル上の絶対パス** として扱う(ソース内ハードコード禁止)
- ドライブ交換・容量拡張が容易(抜いて新しいドライブに差すだけ)
- ドライブ抜去 = 写真閲覧不可(強い物理セキュリティ)

## 現在の設定

| 項目 | 値 |
|---|---|
| ドライブ | 64GB USB メモリ(初回テスト時) |
| パス | `E:\Photo` |
| 役割 | Immich 写真ライブラリ + `album-passwords.json` |

将来的により大きな外付け SSD へ移行予定。

## ドライブ内レイアウト

```
E:\Photo\
├─ immich-library\          Immich の UPLOAD_LOCATION(写真本体)
│  ├─ upload\
│  ├─ library\
│  └─ thumbs\
├─ guard\
│  └─ album-passwords.json  アルバムパスワード設定
├─ backups\                 (将来)定期バックアップの出力先
└─ .drive-check             /drive-check スキル用のマーカーファイル(空でよい)
```

## Docker Desktop File Sharing

Docker コンテナから `E:\` を bind-mount するには Docker Desktop の設定が必要:

1. Docker Desktop を起動
2. Settings → Resources → File sharing
3. 左の「+」をクリックして `E:\` を追加
4. Apply & Restart

未設定だと `docker compose up` で bind mount が **無音で失敗する**(コンテナ内で空ディレクトリに見える)。

検証方法:
```powershell
docker run --rm -v E:/Photo:/x alpine ls /x
```
→ ディレクトリ内容が表示されれば OK。`total 0` なら file sharing 未設定。

## ドライブレターの不安定性

Windows では USB ドライブの **ドライブレターが挿入順で変わる** 可能性がある。

### 対策 1: ドライブレター固定(推奨)

1. `diskmgmt.msc`(ディスクの管理)を開く
2. 該当ドライブを右クリック → **ドライブ文字とパスの変更** → `E:` を永続割り当て

### 対策 2: `/drive-check` スキルで検証

Claude Code から `/drive-check` を実行すると以下を検証:
- `E:\Photo\.drive-check` マーカーファイルの存在
- 書き込み可能
- 空き容量(警告閾値 5 GB)
- Docker Desktop File Sharing 有効

### 対策 3: 設定ファイルで切り替え

ドライブレターが `F:` に変わった場合、`.env` の `PHOTO_STORAGE_PATH` と `immich/.env` の同変数を更新して再起動:

```powershell
cd immich
docker compose down
# .env を編集
docker compose up -d
```

## ホットアンプラグ耐性

- **起動時**: album-guard はドライブのパスを検証し、失敗なら fail-fast(詳細エラーメッセージ)
- **運用中**: ドライブ抜去時 album-guard は 503 Service Unavailable を返す(クラッシュしない)
- **Immich**: 写真ファイルが見えないと 500 を返す(正常動作、データ保護のため)

## ドライブ交換手順

1. 旧ドライブの `E:\Photo\` を新ドライブの同位置にコピー(`robocopy E:\Photo NEW:\Photo /E /COPYALL`)
2. `docker compose down`
3. 旧ドライブを抜く
4. 新ドライブを差し、ドライブレターを `E:` に設定(「対策 1」参照)
5. `docker compose up -d`
6. `/drive-check` で検証

## 推奨ドライブ

| 用途 | 推奨仕様 |
|---|---|
| MVP / テスト | 64GB USB メモリ(現状) |
| 小規模 (〜1万枚) | 500GB 外付け SSD(USB 3.2 Gen 2) |
| 中規模 (〜10万枚) | 1TB 外付け SSD or 2TB 外付け HDD |
| 大規模 | NAS(SMB マウント経由で `PHOTO_STORAGE_PATH`) |

## バックアップ

容量が大きくなるため、別ドライブまたは NAS にバックアップ必須。

### 暫定(手動)
```powershell
robocopy E:\Photo Z:\Photo-backup /E /MT:8 /R:1 /LOG:backup.log
```

### 将来(自動)
`scripts/backup.mjs`(Phase B 以降)で robocopy 実行 + Slack 通知等を予定。

## 故障時リカバリ

ドライブが物理故障した場合:

| データ | 復元方法 |
|---|---|
| 写真本体 | バックアップから復元(未バックアップ分は消失) |
| `album-passwords.json` | バックアップから復元。なければ `/album-add` で再設定 |
| Immich DB | Docker volume 側にあるため、別ドライブなら無事 |

予防策:
- RAID 1 対応の外付けケース(2 ドライブ冗長化)
- 月次で別ディスクへバックアップ
- クラウドバックアップ(Backblaze B2 等、暗号化推奨)
