// album-guard/src/pages/login.js
// /album-guard/login?albumId=<uuid> で返すパスワード入力 HTML を生成する。
// albumId は index.js 側で UUID 形式バリデートされるが、ここでも HTML escape で
// 多層防御を効かせる。動的挿入部分は JSON.stringify で JS 文字列コンテキストに安全に渡す。

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

function renderLoginPage(albumId) {
  const safeHtml = htmlEscape(albumId);
  const safeJs = JSON.stringify(safeHtml);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>アルバム認証</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         display: flex; justify-content: center; align-items: center;
         min-height: 100vh; background: #f5f5f5; margin: 0; }
  .card { background: #fff; padding: 2rem; border-radius: 12px;
          box-shadow: 0 2px 16px rgba(0, 0, 0, .1); width: 100%; max-width: 360px; }
  h2 { margin: 0 0 1.5rem; font-size: 1.2rem; color: #1a1a2e; }
  .meta { font-size: .8rem; color: #888; margin: -1rem 0 1rem; word-break: break-all; }
  input { width: 100%; padding: .75rem; border: 1px solid #ddd; border-radius: 8px;
          font-size: 1rem; box-sizing: border-box; margin-bottom: 1rem; }
  button { width: 100%; padding: .75rem; background: #2e75b6; color: #fff;
           border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #1f4e79; }
  button:disabled { background: #999; cursor: wait; }
  .error { color: #c62828; font-size: .9rem; margin-top: .5rem; display: none; }
</style>
</head>
<body>
<div class="card">
  <h2>🔒 このアルバムはパスワード保護されています</h2>
  <div class="meta">album: ${safeHtml}</div>
  <input type="password" id="pw" placeholder="パスワードを入力" autofocus autocomplete="current-password">
  <button id="submit">認証する</button>
  <div class="error" id="err">パスワードが違います</div>
</div>
<script>
(function () {
  var ALBUM_ID = ${safeJs};
  var btn = document.getElementById('submit');
  var pw = document.getElementById('pw');
  var err = document.getElementById('err');

  async function login() {
    err.style.display = 'none';
    btn.disabled = true;
    try {
      var r = await fetch('/album-guard/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ albumId: ALBUM_ID, password: pw.value }),
      });
      if (!r.ok) {
        err.style.display = 'block';
        pw.select();
        return;
      }
      var j = await r.json();
      sessionStorage.setItem('album_token_' + ALBUM_ID, j.token);
      window.location.href = '/albums/' + ALBUM_ID;
    } catch (_e) {
      err.textContent = '通信エラーが発生しました';
      err.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', login);
  pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
})();
</script>
</body>
</html>`;
}

module.exports = { renderLoginPage, htmlEscape };
