# Phase 11.5 設計メモ: Immich UI 統合

## 現状の課題

Phase 11 (album-guard) は **API レベルでパスワード保護** を行うが、Immich Web UI でブラウザから保護アルバムを直接開くと `401 Unauthorized` が裸で表示される(ユーザー体験が悪い)。

**理想**: Immich Web UI 内で保護アルバムに遷移 → パスワード入力画面に自動遷移 → 入力後、Immich UI 内でアルバムが見える。

## 解決アプローチ

album-guard が Immich の **HTML レスポンスを透過改変** し、ブラウザ側で動作する JS (`/album-guard/inject.js`) を自動注入する。

## 仕組み

```
[Browser]
  │ GET /albums/UUID
  ▼
[album-guard]
  │ 上流 Immich から HTML を取得
  │ </head> 直前に <script src="/album-guard/inject.js"> を注入
  │ Content-Security-Policy ヘッダから script-src を許可するよう書き換え
  ▼
[Browser]
  │ inject.js が実行される
  │  ├ window.fetch をパッチ(X-Album-Token 自動付与)
  │  └ 401 応答時 /album-guard/login?albumId=X にリダイレクト
  ▼
[/album-guard/login]
  │ パスワード入力
  │ POST /album-guard/auth → JWT 取得
  │ sessionStorage['album_token_UUID'] = token
  │ /albums/UUID に戻る
  ▼
[Browser]
  │ inject.js が以降の /api/albums/:UUID* に X-Album-Token を自動付与
  ▼
[album-guard → Immich]
  │ 認証成功、アルバム表示
```

## 実装詳細

### 1. HTML レスポンスの透過改変

`http-proxy-middleware` の `selfHandleResponse: true` を HTML パスのみに有効化:

```js
createProxyMiddleware({
  target: config.IMMICH_URL,
  selfHandleResponse: true,
  on: {
    proxyRes: responseInterceptor(async (buffer, proxyRes, req, res) => {
      if (!isHtmlResponse(proxyRes)) return buffer;
      let html = buffer.toString('utf8');
      html = html.replace(
        '</head>',
        '<script src="/album-guard/inject.js"></script></head>'
      );
      return html;
    }),
  },
});
```

**注意**: `selfHandleResponse` は全レスポンスをバッファする副作用がある。写真本体やサムネイル(巨大)は別経路で透過させる必要あり。

### 2. Content Security Policy

Immich が `Content-Security-Policy` ヘッダで script-src を制限している場合、album-guard が injected script を許可するように書き換える:

```js
const csp = proxyRes.headers['content-security-policy'];
if (csp) {
  proxyRes.headers['content-security-policy'] = rewriteCsp(csp);
}
```

Immich が CSP を付けていない(または `script-src 'self'` 以上に緩い)場合は不要。

### 3. inject.js の強化

仕様書版の inject.js は `X-Album-Token` の自動付与のみ。Phase 11.5 では 401 リダイレクトも追加:

```js
(function () {
  const _fetch = window.fetch;
  window.fetch = async function (url, opts = {}) {
    const m = String(url).match(/\/api\/albums\/([a-f0-9-]{36})/i);
    if (m) {
      const token = sessionStorage.getItem('album_token_' + m[1]);
      if (token) {
        opts.headers = { ...(opts.headers || {}), 'X-Album-Token': token };
      }
    }
    const res = await _fetch(url, opts);
    if (res.status === 401 && m) {
      window.location.href =
        '/album-guard/login?albumId=' + m[1] +
        '&return=' + encodeURIComponent(window.location.pathname);
    }
    return res;
  };
})();
```

### 4. Service Worker 対応

Immich は SvelteKit ベース。Service Worker を使う場合、SW 内の `fetch` は `window.fetch` パッチを回避する。

対応オプション:

1. **inject.js が SW 登録を検知 → SW 内部に別パッチを `postMessage` で送る**
2. **album-guard が `/service-worker.js` のレスポンスも改変して X-Album-Token 付与ロジックを仕込む**
3. **Immich の SW が `/api/albums/*` を intercept しないことを実機確認 → 通常 fetch にフォールバック**

実機で Immich の SW を解析してから決定する。

## 実装コスト見積

| 項目 | LOC | 時間 |
|---|---|---|
| HTML 注入ミドルウェア | ~50 | 2h |
| CSP 書き換え | ~30 | 1h |
| inject.js 強化 | ~40 | 1h |
| Service Worker 対応 | ~50 | 3h(調査込) |
| テスト(Playwright E2E) | ~80 | 2h |
| **合計** | **~250** | **約 9h** |

## 着手判断基準

Phase 11 MVP で以下が確認できてから Phase 11.5 に進む:

- [ ] album-guard が API 保護を正しく動作させる(T1〜T7 すべて pass)
- [ ] `/album-guard/login` 単体でパスワードフローが動く
- [ ] ブラウザ経由で保護アルバムを見れる(手動で /album-guard/login 経由)
- [ ] 実機で Immich の SvelteKit Service Worker の挙動を確認済み

判断材料が揃ったら、実装時間 1 日を確保して着手する。

## 代替案(参考)

### 代替 1: 別 URL パスで Immich UI を提供
album-guard が `/locked/:albumId` のような独自パスを提供し、そこで login ページ + Immich API 呼び出しで自作ビューワを作る。

- **長所**: HTML 改変不要、CSP 考慮不要
- **短所**: Immich UI 機能(検索、アップロード、共有)を作り直す必要あり → スコープ爆発、却下

### 代替 2: Immich にフィーチャーフラグの PR を送る
Immich 本家に「アルバムパスワード」機能を追加する PR を送る。

- **長所**: 根本解決
- **短所**: 本家のポリシー判断・レビュー待ち、時間かかる(数ヶ月〜)

Phase 11.5 は **代替 0(inject.js + HTML 注入)** を採用する。
