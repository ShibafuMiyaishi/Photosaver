# 購入機材リストと選定理由

Photosaver v2(専用 Linux サーバー)の機材構成。2026年8月の調査に基づく。

> **価格に関する注意**: 2026年は AI データセンター需要で DRAM・HDD・SSD が同時高騰中
> (HDD は 2025年9月比で平均約 2.25 倍)。記載価格は 2026年8月上旬の確認値であり、
> 変動する。購入前に必ず下記リンク先で現在価格を確認すること。
> 中古 PC の在庫は数日で回転するが、同クラスは 3〜3.7 万円帯で継続的に出回っている。

## 購入リスト(合計 約5.1万円)

| 品目 | 製品 | 参考価格 | 確認先 |
|---|---|---|---|
| 本体 | 中古 **Dell OptiPlex 7070 Micro**(i5-9500T / 16GB / NVMe 256GB 以上) | ¥32,800〜36,800 | [イオシス](https://iosys.co.jp/items/pc/deskpc/desktop)(3ヶ月保証) / [Qualit](https://www.yrl-qualit.com/)(12ヶ月保証) |
| 写真用 HDD | **東芝 Canvio Desktop 4TB**(HD-TDA4U3)または Buffalo HD-NRLD4.0U3-BA | ¥17,000〜19,000 | [価格.com 外付けHDD 4TB](https://kakaku.com/pc/external-hdd/itemlist.aspx?pdf_Spec301=4000-6000) |

同等の代替本体: Lenovo ThinkCentre M720q/M920q Tiny、HP EliteDesk 800 G4/G5 DM
(いずれも 8〜9世代 Core i5 / 16GB / NVMe 付きなら可)。

## 選定理由

### なぜ中古ビジネスミニ PC か

- **同価格の新品 N100 ミニ PC の約 3 倍の CPU 性能**(i5-9500T は 6コア)。
  数百 GB〜TB 級ライブラリの初回サムネイル生成・ML ジョブで体感差が大きい。
- **RAM 高騰の影響を受けない**: 16GB 搭載済み中古はメモリを昔の価格で調達している。
- **Intel UHD 630 iGPU**:
  - Quick Sync によるハードウェアトランスコード([Immich 公式対応](https://docs.immich.app/features/hardware-transcoding))。
    9世代なので VP9 エンコードまで対応(公式要件: VP9 は 9世代以上)。
  - OpenVINO による ML アクセラレーションも将来有効化可能([公式対応表](https://docs.immich.app/features/ml-hardware-acceleration))。
- **x86-64-v2 要件**(Immich v3 の ML コンテナ必須)を余裕でクリア。
- Micro 筐体は M.2 NVMe + 2.5" SATA ベイ + DDR4 SO-DIMM ×2 で拡張余地あり。
- 電気代: アイドル約 15W ≒ 年間約 4,100 円(31円/kWh)。N100 との差は年 2〜3 千円で誤差。

### 却下した選択肢

| 候補 | 却下理由 |
|---|---|
| 新品 N100/N150 ミニ PC | 同価格で性能 1/3。2026年の値上がりで価格優位も消えた |
| Raspberry Pi 5 16GB | ¥60,000 超に高騰。HW エンコーダ無し・Immich の ML アクセラレーション非対応 |
| NAS 単体 | 普及帯 NAS は CPU が弱く Immich の ML/サムネイル生成に不向き。NFS のランダム IOPS は実測でローカル SSD の数百分の一 |
| 大容量 NVMe に写真を集約 | 2TB NVMe が 5〜6 万円の市況では非合理 |

### HDD は 4TB・1台のみ(設計判断)

本プロジェクトは**イベント写真の一時共有置き場**であり、恒久アーカイブではない
(設計方針の詳細は [architecture.md](architecture.md))。よって:

- 写真原本のバックアップドライブは**買わない**(HDD 故障 = データ喪失を許容)
- 4TB で足りなくなったら大容量 HDD を買い足して移行する(2026年時点で 6〜8TB が ¥/TB 最良)
- 参加者には「残したい写真は各自の端末に保存する」運用を案内する

セルフパワー(AC アダプタ給電)の 3.5" 据置型を選ぶこと。
バスパワーの 2.5" ポータブルは 24時間運用での故障報告が多く不可。

## あとから買い足す候補(必須ではない)

| 品目 | 目安 | 買うタイミング |
|---|---|---|
| 大容量 HDD(6〜8TB) | ¥24,000〜30,000 | 4TB の使用率が 80% を超えたら |
| 正弦波 UPS(CyberPower CP1200PFCLCDJP 等) | 約¥16,500 | 停電による Postgres/Btrfs 破損が心配になったら |
| 内蔵 2.5" SSD/HDD(空きベイ用) | 市況次第 | 外付け USB の安定性に不満が出たら |

## 購入時のチェックリスト

- [ ] 本体: RAM 16GB / NVMe 256GB 以上 / AC アダプタ付属を確認
- [ ] 本体: 保証期間を確認(Qualit は 12ヶ月)
- [ ] HDD: 3.5" セルフパワー型か確認(ポータブル型を買わない)
- [ ] 納品後: BIOS 起動確認 → すぐ [new-server-setup.md](new-server-setup.md) へ
