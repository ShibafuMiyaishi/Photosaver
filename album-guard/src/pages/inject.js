// album-guard/src/pages/inject.js
// /album-guard/inject.js で返す、ブラウザ側でトークン自動付与するスクリプト。
// Phase 11.5 では Immich HTML に <script> タグとして自動注入される計画。
// 現 MVP では endpoint のみ提供(手動 <script> 追加や将来の自動注入のための器)。

const INJECT_SCRIPT = `(function () {
  var _fetch = window.fetch;
  window.fetch = function (url, opts) {
    opts = opts || {};
    try {
      var m = String(url).match(/\\/api\\/albums\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) {
        var token = sessionStorage.getItem('album_token_' + m[1]);
        if (token) {
          var headers = Object.assign({}, opts.headers || {});
          headers['X-Album-Token'] = token;
          opts.headers = headers;
        }
      }
    } catch (_e) { /* ignore URL parse errors */ }
    return _fetch(url, opts);
  };
})();
`;

function renderInjectScript() {
  return INJECT_SCRIPT;
}

module.exports = { renderInjectScript };
