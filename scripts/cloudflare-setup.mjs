#!/usr/bin/env node
// scripts/cloudflare-setup.mjs
// Cloudflare Tunnel を API 経由で自動セットアップする。
//
// 必要な環境変数(.env に記入):
//   CLOUDFLARE_API_TOKEN     — Account>Tunnel:Edit + Zone>DNS:Edit + Zone>Zone:Read
//   CLOUDFLARE_ACCOUNT_ID    — Dashboard 右サイドバーの Account ID
//   CLOUDFLARE_ZONE_NAME     — 移管済ドメイン(例: yourdomain.com)
//   CLOUDFLARE_HOSTNAME      — 公開ホスト名(例: photos.yourdomain.com)
//
// 成功時:
//   - tunnel "hpss-album-guard" を作成(存在すれば再利用)
//   - ingress を hostname → http://album-guard:3000 に設定
//   - DNS CNAME hostname → {tunnel_id}.cfargotunnel.com を proxied で作成/更新
//   - CLOUDFLARE_TUNNEL_TOKEN を immich/.env に書き込み
//
// 冪等: 既存リソースは再利用 + 上書き。破壊操作はしない。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const API = 'https://api.cloudflare.com/client/v4';
const TUNNEL_NAME = 'hpss-album-guard';
const SERVICE_URL = 'http://album-guard:3000';

function die(msg, exit = 1) {
  console.error(`❌ ${msg}`);
  process.exit(exit);
}

async function cf(token, pathPart, opts = {}) {
  const res = await fetch(API + pathPart, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const errs = (data.errors || []).map((e) => `[${e.code}] ${e.message}`).join(', ');
    throw new Error(
      `Cloudflare API ${opts.method || 'GET'} ${pathPart} → ${res.status}: ${errs || JSON.stringify(data).slice(0, 300)}`,
    );
  }
  return data.result;
}

async function findOrCreateTunnel(token, accountId) {
  const list = await cf(
    token,
    `/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(TUNNEL_NAME)}`,
  );
  if (list && list.length > 0) {
    console.log(`♻️  existing tunnel found: ${list[0].id}`);
    return list[0];
  }
  console.log(`📡 creating tunnel "${TUNNEL_NAME}"...`);
  const created = await cf(token, `/accounts/${accountId}/cfd_tunnel`, {
    method: 'POST',
    body: JSON.stringify({ name: TUNNEL_NAME, config_src: 'cloudflare' }),
  });
  console.log(`✅ tunnel created: ${created.id}`);
  return created;
}

async function getTunnelToken(token, accountId, tunnelId) {
  return cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
}

async function setIngress(token, accountId, tunnelId, hostname) {
  console.log(`🎯 configuring ingress: ${hostname} → ${SERVICE_URL}`);
  return cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname, service: SERVICE_URL },
          { service: 'http_status:404' },
        ],
      },
    }),
  });
}

async function findZone(token, zoneName) {
  const zones = await cf(token, `/zones?name=${encodeURIComponent(zoneName)}`);
  if (!zones || zones.length === 0) {
    die(
      `zone "${zoneName}" not found in your Cloudflare account — ドメインを Cloudflare に移管する必要があります`,
    );
  }
  return zones[0];
}

async function upsertDnsCname(token, zoneId, hostname, tunnelId) {
  const content = `${tunnelId}.cfargotunnel.com`;
  const existing = await cf(
    token,
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
  );
  if (existing && existing.length > 0) {
    console.log(`♻️  existing CNAME ${hostname} found, pointing it at the tunnel`);
    return cf(token, `/zones/${zoneId}/dns_records/${existing[0].id}`, {
      method: 'PUT',
      body: JSON.stringify({
        type: 'CNAME',
        name: hostname,
        content,
        proxied: true,
        ttl: 1,
      }),
    });
  }
  console.log(`📝 creating CNAME ${hostname} → ${content}`);
  return cf(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'CNAME',
      name: hostname,
      content,
      proxied: true,
      ttl: 1,
    }),
  });
}

function writeTokenToEnvFile(tunnelToken) {
  const envPath = path.join(REPO_ROOT, 'immich', '.env');
  if (!fs.existsSync(envPath)) {
    die(`${envPath} not found. まず cp immich/.env.example immich/.env を実行してください。`);
  }
  let text = fs.readFileSync(envPath, 'utf8');
  const line = `CLOUDFLARE_TUNNEL_TOKEN=${tunnelToken}`;
  if (/^CLOUDFLARE_TUNNEL_TOKEN=/m.test(text)) {
    text = text.replace(/^CLOUDFLARE_TUNNEL_TOKEN=.*$/m, line);
  } else {
    text += (text.endsWith('\n') ? '' : '\n') + line + '\n';
  }
  fs.writeFileSync(envPath, text);
  console.log('💾 tunnel token → immich/.env (CLOUDFLARE_TUNNEL_TOKEN)');
}

async function main() {
  loadEnv();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const zoneName = process.env.CLOUDFLARE_ZONE_NAME;
  const hostname = process.env.CLOUDFLARE_HOSTNAME;

  if (!apiToken) die('CLOUDFLARE_API_TOKEN が設定されていません(.env)');
  if (!accountId) die('CLOUDFLARE_ACCOUNT_ID が設定されていません(.env)');
  if (!zoneName) die('CLOUDFLARE_ZONE_NAME が設定されていません(例: yourdomain.com)');
  if (!hostname) die('CLOUDFLARE_HOSTNAME が設定されていません(例: photos.yourdomain.com)');
  if (!hostname.endsWith(zoneName)) {
    die(`CLOUDFLARE_HOSTNAME "${hostname}" は CLOUDFLARE_ZONE_NAME "${zoneName}" のサブドメインでなければなりません`);
  }

  console.log(`\n🔧 Cloudflare Tunnel setup\n   hostname: ${hostname}\n   zone:     ${zoneName}\n`);

  const tunnel = await findOrCreateTunnel(apiToken, accountId);
  const tunnelToken = await getTunnelToken(apiToken, accountId, tunnel.id);
  writeTokenToEnvFile(tunnelToken);
  await setIngress(apiToken, accountId, tunnel.id, hostname);
  const zone = await findZone(apiToken, zoneName);
  await upsertDnsCname(apiToken, zone.id, hostname, tunnel.id);

  console.log(`
✅ Cloudflare Tunnel setup complete.

  tunnel id: ${tunnel.id}
  hostname:  https://${hostname}
  service:   ${SERVICE_URL}

次のステップ:
  1. cd immich && docker compose --profile public up -d --build
  2. node scripts/cloudflare-verify.mjs
`);
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
