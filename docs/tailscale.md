# Tailscale リモートアクセス(Photosaver v2)

Immich への唯一のアクセス経路。ドメイン不要・ポート開放なし・無料。
イベント時のゲスト用窓口(guest-gateway)だけは、別ノードから Funnel で期間限定公開する(下記)。

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

## ゲスト用窓口ノード(guest-gateway、イベント時のみ)

アカウントも Tailscale も持たないゲスト向けのアップロード窓口は、ミニ PC 本体とは**別の Tailscale ノード**
(`tag:wedding-gw`)として Funnel で公開する。設計・手順の詳細は [guest-gateway.md](guest-gateway.md)。

- 窓口は別 compose プロジェクト `wedding-gw` の ts サイドカー(`tailscale/tailscale` コンテナ)が
  ノードとして tailnet に参加し、Funnel の HTTPS 終端を担う。ホストの serve 設定には触れない
- 管理画面での準備: Access controls に `tagOwners`(`tag:wedding-gw`)と `nodeAttrs`(`funnel`)を追記し、
  Tags `tag:wedding-gw` の認証キーを発行する(手順は [guest-gateway.md](guest-gateway.md) の準備手順 2)
- Funnel は Tailscale 1.38.3 以上が必要(窓口のサイドカーは `tailscale/tailscale:v1.102`。ホスト側の版は `.claude/handoff/tasks.md` の T1 で確認)
- Funnel の帯域上限は非公開のため、イベント前に実機で速度を測って採否を決める
- 止めるときは `cd ~ && docker compose -p wedding-gw down`。イベント後は窓口ノードの削除・認証キーの失効・
  `nodeAttrs` の funnel 行の削除まで行う

> ⚠️ ミニ PC 本体で `tailscale funnel reset` / `tailscale serve reset` を実行しない。
> Immich の tailnet 公開(443 → 127.0.0.1:2283)まで消える。

## 将来の拡張: アプリを入れない人への閲覧共有

「URL を送るだけで見せたい」需要が出たら、**Immich Public Proxy (IPP)** +
**Tailscale Funnel** を追加する(Immich 本体は非公開のまま、読み取り専用の
IPP だけを公開する定石構成):

- [IPP](https://github.com/alangrainger/immich-public-proxy) は Immich の共有リンク
  (パスワード・期限付き)だけを外に出すステートレスなプロキシ。API キー不要
- [Funnel](https://tailscale.com/kb/1223/funnel) は全プランで利用可。
  帯域制限あり(非公開値)のため単発のリンク共有向け
- 現構成への追加はコンテナ 1 つ + Funnel の設定で、既存部分の変更は不要

ゲストに**アップロードしてもらう**用途は IPP では対応できない(読み取り専用)ため、上記の窓口で対応する。

## トラブルシューティング

| 症状 | 確認 |
|---|---|
| 全員繋がらない | サーバーで `tailscale status`(logged out になっていないか)、`tailscale serve status` |
| 特定の友達だけ繋がらない | 友達側の VPN オン確認 → 共有の承認状態(Machines → Shared with) → フル FQDN を使っているか |
| 証明書エラー | 管理画面で HTTPS Certificates が有効か。`tailscale serve status` で設定を確認し、消えていれば上記「サーバー側の設定」のコマンドで再設定する(`serve reset` は使わない) |
| 速度が遅い | `tailscale status` で相手との接続が direct か relay(DERP)か確認。relay ならルーターの NAT 設定(UPnP)を見直す |
| ゲスト用窓口に外から届かない | [guest-gateway.md](guest-gateway.md) の「困ったとき」。ホストの serve / funnel 設定は触らない |
