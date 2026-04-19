// scripts/_env.mjs
// .env と immich/.env を手動で読み込み process.env に反映するユーティリティ。
// dotenv の import を避けて scripts/ を依存フリーに保つ。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export function loadEnv(files = ['.env', 'immich/.env']) {
  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let value = m[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      // Do not overwrite already-set env vars.
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    }
  }
}
