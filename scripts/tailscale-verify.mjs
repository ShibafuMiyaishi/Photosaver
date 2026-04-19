#!/usr/bin/env node
// scripts/tailscale-verify.mjs
// Tailscale + album-guard の到達性を検証:
//   1) `tailscale` CLI が PATH にあるか
//   2) `tailscale status` で Tailscale が running か
//   3) `tailscale serve status` で HTTPS 設定があるか
//   4) localhost:3000 で album-guard ヘルスが返るか
//   5) Tailscale の自機 IP + MagicDNS hostname を表示
//
// Exit codes:
//   0 = すべて OK
//   1 = どこかで失敗
//   2 = 実行環境の問題(Node 等)

import { execSync } from 'node:child_process';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    return { error: e, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}

function log(icon, msg) {
  console.log(`${icon}  ${msg}`);
}

async function main() {
  let allPass = true;
  console.log('\n🌐 Tailscale verify\n');

  // 1. tailscale CLI
  const ver = run('tailscale version');
  if (typeof ver === 'string') {
    log('✅', `tailscale CLI: ${ver.split('\n')[0]}`);
  } else {
    log('❌', 'tailscale CLI not found on PATH');
    log('   ', '→ https://tailscale.com/download/windows からインストールしてください');
    finish(false);
    return;
  }

  // 2. status
  const st = run('tailscale status --json');
  if (typeof st !== 'string') {
    log('❌', `tailscale status failed: ${st.stderr || st.error.message}`);
    log('   ', '→ Tailscale が起動していない可能性。タスクトレイのアイコンを確認。');
    allPass = false;
  } else {
    try {
      const j = JSON.parse(st);
      const me = j.Self || {};
      log('✅', `Tailscale running as: ${me.HostName || '(unknown)'}  (DNSName: ${me.DNSName || '-'})`);
      const myIp = (me.TailscaleIPs || [])[0];
      if (myIp) log('ℹ️ ', `  Tailscale IP: ${myIp}`);
      const online = (me.Online === true);
      if (!online) {
        log('⚠️ ', '  Self is Online=false(サインイン切れの可能性)');
        allPass = false;
      }
    } catch (e) {
      log('⚠️ ', `tailscale status --json の JSON parse 失敗: ${e.message}`);
    }
  }

  // 3. serve status
  const serve = run('tailscale serve status');
  if (typeof serve === 'string' && serve.trim()) {
    if (/https/i.test(serve) && /localhost:3000|127\.0\.0\.1:3000/i.test(serve)) {
      log('✅', 'tailscale serve: HTTPS → localhost:3000 構成あり');
      // Extract URL
      const m = serve.match(/https:\/\/([\w.-]+\.ts\.net)/i);
      if (m) log('ℹ️ ', `  公開 URL: https://${m[1]}`);
    } else {
      log('⚠️ ', 'tailscale serve に HTTPS→localhost:3000 の設定が見当たらない');
      log('   ', '→ `tailscale serve --bg --https=443 localhost:3000` を実行してください');
      allPass = false;
    }
  } else {
    log('⚠️ ', 'tailscale serve 設定なし');
    log('   ', '→ `tailscale serve --bg --https=443 localhost:3000` を実行してください');
    allPass = false;
  }

  // 4. album-guard health via loopback
  try {
    const res = await fetch('http://localhost:3000/album-guard/health', {
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json().catch(() => null);
    if (res.ok && j && j.status === 'ok') {
      log('✅', 'album-guard /health on localhost:3000 → ok');
    } else {
      log('❌', `album-guard /health → HTTP ${res.status}`);
      allPass = false;
    }
  } catch (e) {
    log('❌', `album-guard /health fetch 失敗: ${e.message}`);
    log('   ', '→ `docker compose ps` で album_guard が healthy か確認してください');
    allPass = false;
  }

  finish(allPass);
}

function finish(ok) {
  console.log('');
  if (ok) {
    console.log('✅ Tailscale + album-guard のセットアップは正常です');
    process.exit(0);
  } else {
    console.log('⚠️  一つ以上の check が失敗 — 上のメッセージに従って対処してください');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('fatal:', e.stack || e.message);
  process.exit(2);
});
