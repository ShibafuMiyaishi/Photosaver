---
description: Test code and log files must live under the repo-relative tmp/ directory — never pollute source trees
paths: "**/*.test.js, **/*.spec.js, **/test/**, **/tests/**, **/__tests__/**, scripts/**/*.mjs"
---

## `tmp/` workspace rule

All ephemeral artifacts — test scratch files, test output, debug logs, Playwright
traces, generated fixtures, anything temporary — must live under the repo-relative
**`tmp/`** directory at the repo root:

```
C:\Users\fumiy\Desktop\code\Photosaver\tmp\
```

(In code: `./tmp/` or `path.resolve(__dirname, '../../tmp')`.)

### NOT the system `/tmp`

Do NOT use the OS temp directory (`/tmp` on Linux, `%TEMP%` on Windows) for project
test artifacts. Use the repo-scoped `./tmp/` instead, so artifacts stay discoverable
and cleanable next to the code that produced them.

### Subdivide by purpose

```
tmp/
├─ logs/          アプリケーション/テストのログ
├─ fixtures/      テスト用に生成した入力データ
├─ test-output/   テスト結果のキャプチャ / カバレッジ生データ
└─ e2e/           Playwright のトレース・スクリーンショット
```

Create subdirectories on demand (`fs.mkdirSync(dir, { recursive: true })`).

## Why

1. **本番コードを汚さない** — `album-guard/src/` や `scripts/` にテスト副産物が残らない
2. **ログ管理が楽** — 1 箇所見れば全部ある、`rm -rf tmp/*` で一掃できる
3. **git に巻き込まない** — `.gitignore` で `tmp/` を丸ごと除外 → ログを誤コミットする事故を防止
4. **CI との互換** — ローカルと CI で同じパス構造にできる

## Enforcement

- **`.gitignore`** に `tmp/` を登録済(プロジェクト直下)。
- **テストコード**はログ/フィクスチャを `./tmp/...` 配下にのみ書き出すこと。
- **Playwright** は `outputDir`, `traceDir` を `./tmp/e2e/` に設定すること。
- **Vitest** は `reporters` の file 出力を `./tmp/test-output/` に向けること。

## 具体例

✅ 正しい:

```js
// album-guard/test/auth.test.js
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, beforeAll } from 'vitest';

const TMP = path.resolve(__dirname, '../../tmp/test-output');

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

it('writes debug log to tmp', () => {
  fs.writeFileSync(path.join(TMP, 'auth-debug.json'), JSON.stringify({...}));
});
```

❌ 避ける:

```js
fs.writeFileSync('/tmp/my-log.json', ...);              // OS system /tmp
fs.writeFileSync('./src/test-output.json', ...);        // 本番ソースを汚染
fs.writeFileSync('./album-guard/debug.log', ...);       // ソースツリーを汚染
fs.writeFileSync(os.tmpdir() + '/x.log', ...);          // repo 外
```

## Cleanup

- ローカルで再現する時は `rm -rf tmp` で一掃してから実行
- CI では毎回クリーンチェックアウトなので cleanup 不要(念のため artifact アップロード時に `tmp/e2e/` だけ保存)
- サブディレクトリが見つからない場合、コード側で `mkdirSync(..., { recursive: true })` して自動作成

## When you see test or log code NOT following this convention

Refactor it as part of the current change. Do not leave mixed conventions in the tree —
inconsistency is worse than either rule alone.
