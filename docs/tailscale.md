# Tailscale リモートアクセス(Photosaver v2)

外部公開の唯一の経路。ドメイン不要・ポート開放なし・無料。

## 料金プランの前提(2026年8月確認)

- **Personal(無料)プラン: 6 ユーザーまで、ユーザー所有デバイス数は無制限**
  (2026年4月8日の [公式プラン改定](https://tailscale.com/blog/pricing-v4) で拡張された)
- **node sharing(マシン共有)は無料枠を消費しない**: 友達を tailnet の
  「ユーザー」として招待すると 6 人枠を使うが、photosaver マシンだけを
  共有する分には人数制限なし・双方無料
  ([sharing](https://tailscale.com/kb/1084/sharing) /
  [inviting vs sharing](https://tailscale.com/docs/reference/inviting-vs-sharing))
- 使い分け: **家族(全マシンにアクセスさせたい人)= ユーザー招待、友達 = node sharing**

## サーバー側の設定

セットアップ手順は [new-server-setup.md](new-server-setup.md) 手順 7。要点:

```bash
sudo tailscale up
sudo tailscale serve --bg --https=443 http://127.0.0.1:2283
```

- `--bg` の設定は**再起動後も永続**([公式](https://tailscale.com/kb/1242/tailscale-serve))
- 証明書は ts.net ドメインの**正規 Let's Encrypt 証明書**。スマホアプリからも
  警告なしで使える(管理画面で MagicDNS + HTTPS Certificates の有効化が前提)
- 管理画面 → Machines → photosaver の **Key expiry を Disable** にしておく
  (キー期限切れによる突然の接続断を防ぐ)

## 友達の招待(node sharing)

1. [Machines](https://login.tailscale.com/admin/machines) → photosaver → **Share...** →
   招待リンクを発行して送る
2. 友達は Tailscale アカウント(無料)を作って承認するだけ。
   photosaver マシンだけが友達の Tailscale アプリに現れる
3. **URL は必ずフル FQDN**(`https://photosaver.<tailnet名>.ts.net`)を案内する。
   共有された側は短縮名では解決できない
4. おまけ: 共有が成立すると双方のデバイス上限が +2 される

こちらの tailnet の他のマシンは友達から見えない(共有したノードのみ)。
ACL でさらに絞ることも可能だがデフォルトで十分。

## 既知の制約(友達に伝える期待値)

- スマホの**バックグラウンド自動バックアップはベストエフォート**:
  - iOS: OS の制約でアプリを開いた時にまとめて追いつく挙動になりがち
    (Background App Refresh オン + 低電力モードオフで改善)
  - Android: 一部端末で Tailscale 併用時にアップロードが止まる既知の不具合あり
    ([tailscale/tailscale#17982](https://github.com/tailscale/tailscale/issues/17982)、
    2026年8月時点で未解決)。「アプリを開けば上がる」が回避策
- Tailscale の VPN をオフにするとサーバーに繋がらない。
  「写真が上がらない」の 9 割はこれ
- 電池消費は実用上ほぼ気にならない(WireGuard はアイドルが軽い)

## 将来の拡張: アプリを入れない人への共有

「URL を送るだけで見せたい」需要が出たら、**Immich Public Proxy (IPP)** +
**Tailscale Funnel** を追加する(Immich 本体は非公開のまま、読み取り専用の
IPP だけを公開する定石構成):

- [IPP](https://github.com/alangrainger/immich-public-proxy) は Immich の共有リンク
  (パスワード・期限付き)だけを外に出すステートレスなプロキシ。API キー不要
- [Funnel](https://tailscale.com/kb/1223/funnel) は全プランで利用可。
  帯域制限あり(非公開値)のため単発のリンク共有向け
- 現構成への追加はコンテナ 1 つ + `tailscale funnel` 1 コマンドで、既存部分の変更は不要

## トラブルシューティング

| 症状 | 確認 |
|---|---|
| 全員繋がらない | サーバーで `tailscale status`(logged out になっていないか)、`tailscale serve status` |
| 特定の友達だけ繋がらない | 友達側の VPN オン確認 → 共有の承認状態(Machines → Shared with) → フル FQDN を使っているか |
| 証明書エラー | 管理画面で HTTPS Certificates が有効か。`tailscale serve` を一度リセット(`sudo tailscale serve reset` → 再設定) |
| 速度が遅い | `tailscale status` で相手との接続が direct か relay(DERP)か確認。relay ならルーターの NAT 設定(UPnP)を見直す |
