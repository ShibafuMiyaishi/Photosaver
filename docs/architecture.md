# システム構成

HPSS / Photosaver のコンポーネント構成と通信経路。

## 全体像

```
[スマホアプリ / ブラウザ (Tailscale client)]
        │
        ▼
[Tailscale WireGuard mesh VPN]
        │
        ▼
[家の Windows PC (Tailscale installed)]
        │  https://<host>.<tailnet>.ts.net 終端
        │  (`tailscale serve --https=443 → localhost:3000`)
        ▼
[album-guard :3000]         ← 認証プロキシ (Phase 11 追加)
        │
        ├─ /api/albums/:uuid*  → アルバム UUID 単位で認証チェック
        ├─ /album-guard/*      → ログイン/管理画面(カスタム UI)
        └─ その他              → 透過通過
        │
        ▼
[immich-server :2283]       ← 写真管理 OSS 本体
        │
        ├─ immich-machine-learning
        ├─ immich-db (Postgres)
        └─ immich-redis
        │
        ▼
[外付けドライブ E:\Photo]   ← 写真データ本体
```

## コンポーネント責務

### album-guard (Phase 11 新規)
Node.js / Express 製リバースプロキシ。本プロジェクトの中核。

- **役割**: アルバム単位のパスワード認証を API レベルで実施
- **ポート**: 3000(`127.0.0.1` バインド、Tailscale serve 経由で HTTPS 公開)
- **ソース**: `album-guard/src/`
- **データ**: `album-passwords.json`(`E:\Photo\guard\` に配置、bind-mount)
- **認証方式**: bcrypt パスワードハッシュ + HS256 JWT トークン
- **ホットリロード**: `album-passwords.json` の変更を `fs.watch` で検知、自動再読込

#### 保護対象エンドポイント(仕様書 11.1.3)

| エンドポイント | 挙動 |
|---|---|
| `GET /api/albums/:uuid` | 保護対象 UUID の場合 401 |
| `GET /api/albums/:uuid/assets` | 同上 |
| `PUT /api/albums/:uuid/assets` | 同上 |
| `DELETE /api/albums/:uuid/assets` | 同上 |
| `GET /api/assets/:id` | 現時点では素通し(制限事項、後述) |
| その他 `/api/*` | 素通し |

#### 独自エンドポイント

- `POST /album-guard/auth` — パスワード検証 → JWT 発行
- `POST /album-guard/hash` — bcrypt ハッシュ生成(管理者用)
- `GET /album-guard/health` — ヘルスチェック
- `GET /album-guard/login?albumId=X` — ブラウザ用ログイン画面
- `GET /album-guard/inject.js` — ブラウザ向けトークン自動付与スクリプト(Phase 11.5 で本格活用)

### Immich (upstream、改造しない)
OSS 写真管理プラットフォーム。

- **immich-server**: Web UI + REST API、内部ポート 2283
- **immich-machine-learning**: 顔認識・物体検出・検索インデックス
- **immich-db**: PostgreSQL メタデータストア
- **immich-redis**: ジョブキュー

### Tailscale(ホスト OS にインストール)
Photosaver の外部公開を担う。WireGuard ベースのメッシュ VPN。

- ドメイン不要・クレジットカード不要・無料(3 ユーザー + 100 デバイスまで)
- `tailscale serve --bg --https=443 localhost:3000` で HTTPS 終端 + album-guard への転送
- 到達可能なのは tailnet に招待された端末のみ(パブリック URL ではない)
- 仕様書 11.5.2 の Cloudflare Tunnel 方式は未使用(ドメイン必須のため本プロジェクトでは代替)

## リクエストフロー

### パスワードなしアルバム
```
Client (Tailscale) → Tailscale serve (HTTPS 終端)
       → album-guard (UUID 照合 → 保護対象外)
       → immich-server → レスポンス
```

### パスワード付きアルバム(未認証)
```
Client → album-guard (UUID 保護対象、X-Album-Token なし)
       → 401 Unauthorized + エラー JSON
```

### パスワード付きアルバム(認証済み)
```
Client → album-guard (UUID 保護対象、X-Album-Token 検証成功)
       → immich-server → レスポンス
```

### パスワード認証フロー
```
Client → POST /album-guard/auth { albumId, password }
       → album-guard が bcrypt 比較
       → 成功時 JWT を返却
       → Client が X-Album-Token ヘッダーに付けて以降のリクエストを発行
```

## 設計上の制限事項

- `/api/assets/:assetId` の直接アクセスは、アルバム紐付けの確認コストが高いため **保護対象外**。アルバム一覧・アルバム内写真一覧を保護することで「存在・内容が見えない」実用的保護を達成する
- Immich 公式スマホアプリは `X-Album-Token` 送信機能を持たないため、パスワード付きアルバムはブラウザ利用を推奨
- ブラウザで Immich Web UI を開くと、現 MVP では 401 エラーが直接見える(UX が悪い)。これは **Phase 11.5** で HTML 自動注入により解決予定

## データフローとストレージ

| データ | 保存先 | 理由 |
|---|---|---|
| 写真ファイル本体 | `E:\Photo\immich-library\` | 容量大、外付けで拡張可能 |
| Immich メタデータ (DB) | Docker volume(ローカル) | 再起動耐性、小容量 |
| `album-passwords.json` | `E:\Photo\guard\` | 「ドライブ抜去 = 全オフライン」の物理セキュリティ整合 |
| `.env` secrets | ローカルファイル(gitignore) | 流出防止 |

## 関連ドキュメント
- 運用手順: [operations.md](operations.md)
- パスワード管理: [password-management.md](password-management.md)
- 外付けドライブ: [external-drive.md](external-drive.md)
- Tailscale リモートアクセス: [tailscale.md](tailscale.md)
- Phase 11.5 設計: [phase-11.5-design.md](phase-11.5-design.md)
