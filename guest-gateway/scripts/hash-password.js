// guest-gateway/scripts/hash-password.js
// 合言葉の scrypt ハッシュを生成して標準出力に出す(.env の GUEST_PASSWORD_HASH / ADMIN_PASSWORD_HASH 用)。
// パラメータは N=2^17, r=8, p=1(OWASP 推奨、約 128 MiB・1 回 0.2〜0.5 秒)。以前の N=2^14 の
// ハッシュもそのまま使えるが、作り直すとこの強さになる。
// 合言葉はシェル履歴に残らないよう標準入力から読む。ミニPC(Node なし)ではイメージ経由で実行:
//   read -rs P && printf '%s' "$P" | docker run --rm -i guest-gateway node scripts/hash-password.js; unset P
// ローカル開発(Mac)なら:
//   read -rs P && printf '%s' "$P" | npm run -s hash-password; unset P

import { hashPassword } from '../src/auth.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks)
  .toString('utf8')
  .replace(/\r?\n$/, '');

if (password.length < 8) {
  console.error('[guest-gateway] password must be at least 8 characters (read from stdin)');
  process.exit(1);
}

console.log(await hashPassword(password));
