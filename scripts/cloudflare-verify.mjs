#!/usr/bin/env node
// scripts/cloudflare-verify.mjs
// Cloudflare Tunnel の動作を 3 レイヤで検証:
//   1) API: tunnel が存在し active な connection があるか
//   2) DNS: hostname が CNAME として解決できるか(DoH で Cloudflare 自身に問い合わせ)
//   3) HTTP: https://{hostname}/album-guard/health に到達し JSON で {status:"ok"} が返るか

import { loadEnv } from './_env.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const TUNNEL_NAME = 'hpss-album-guard';

async function cf(token, pathPart) {
  const res = await fetch(API + pathPart, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`CF ${pathPart} → ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result;
}

async function checkTunnel(token, accountId) {
  console.log('\n1️⃣  Cloudflare Tunnel API status...');
  try {
    const list = await cf(
      token,
      `/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(TUNNEL_NAME)}`,
    );
    if (!list || list.length === 0) {
      console.log(`   ❌ tunnel "${TUNNEL_NAME}" not found — scripts/cloudflare-setup.mjs を先に実行してください`);
      return false;
    }
    const t = list[0];
    const conns = Array.isArray(t.connections) ? t.connections : [];
    const active = conns.length;
    const ok = active > 0;
    console.log(
      `   ${ok ? '✅' : '❌'} name=${t.name} status=${t.status} active_connections=${active}`,
    );
    if (!ok) {
      console.log(
        '   → cloudflared コンテナが起動していない可能性。docker compose --profile public up -d で起動してください。',
      );
    }
    return ok;
  } catch (e) {
    console.log(`   ❌ API error: ${e.message}`);
    return false;
  }
}

async function checkDns(hostname) {
  console.log('\n2️⃣  DNS resolution (via Cloudflare DoH)...');
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`,
      { headers: { Accept: 'application/dns-json' } },
    );
    const data = await res.json();
    const records = (data.Answer || []).map((r) => r.data).filter(Boolean);
    if (records.some((r) => r.includes('cfargotunnel.com'))) {
      console.log(`   ✅ ${hostname} → ${records.join(', ')}`);
      return true;
    }
    if (records.length > 0) {
      console.log(`   ⚠️  ${hostname} → ${records.join(', ')} (cfargotunnel.com を指していません)`);
      return false;
    }
    console.log(`   ❌ ${hostname} が解決できません(DNS 伝搬待ちの可能性・最大 5 分)`);
    return false;
  } catch (e) {
    console.log(`   ❌ DoH 失敗: ${e.message}`);
    return false;
  }
}

async function checkHttp(hostname) {
  console.log('\n3️⃣  HTTP end-to-end (album-guard/health through tunnel)...');
  try {
    const url = `https://${hostname}/album-guard/health`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      /* not JSON */
    }
    if (res.ok && json && json.status === 'ok') {
      console.log(`   ✅ ${url} → ${JSON.stringify(json)}`);
      return true;
    }
    console.log(`   ❌ ${res.status}: ${text.slice(0, 200)}`);
    return false;
  } catch (e) {
    console.log(`   ❌ fetch 失敗: ${e.message}`);
    return false;
  }
}

async function main() {
  loadEnv();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const hostname = process.env.CLOUDFLARE_HOSTNAME;
  if (!token || !accountId || !hostname) {
    console.error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_HOSTNAME が .env に必要です');
    process.exit(2);
  }

  const results = await Promise.all([
    checkTunnel(token, accountId),
    checkDns(hostname),
    checkHttp(hostname),
  ]);
  const [tun, dns, http] = results;

  console.log('');
  if (tun && dns && http) {
    console.log('✅ Cloudflare Tunnel is fully operational');
    process.exit(0);
  }
  console.log('⚠️  one or more checks failed — 上のログで原因を確認してください');
  process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e.stack || e.message);
  process.exit(2);
});
