---
description: Git commit message conventions — every commit must include per-file summaries in Japanese
---

Every git commit in this repo MUST include a **per-file summary list** in the commit
message body. Each changed file gets **one concise Japanese line** describing what
was changed in that file.

## Format

```
<subject line — either language, short>

<file-path-1>: <1行の日本語要約>
<file-path-2>: <1行の日本語要約>
<file-path-3>: <1行の日本語要約>
```

- The subject line stays short (< 70 chars). Language can be Japanese or English.
- The body must have a blank line after the subject, then one entry per changed file.
- File paths are repo-relative, forward-slash style.

## Examples

✅ Good:

```
Add album-guard auth logic

album-guard/src/auth.js: bcrypt比較とJWT発行関数を実装
album-guard/src/config.js: GUARD_JWT_SECRET を環境変数から読み込むよう追加
album-guard/test/auth.test.js: verifyToken の期限切れ・改ざんケースのテスト追加
docs/password-management.md: ハッシュ生成手順を仕様書の2方式で併記
```

```
CLAUDE.md のセキュリティ不変条件を強化

CLAUDE.md: bcrypt ラウンド数の下限と JWT アルゴリズム固定を明記
.claude/rules/auth.md: トークンとアルバム UUID の紐付け検証ルールを追加
```

❌ Avoid:

- Subject line だけで本文なし
- 英語のみの per-file 要約
- 「update file」「修正」のような曖昧な要約
- 1 ファイル複数行(1 ファイル = 1 行厳守)
- ファイルを漏らす(`git log --stat` との整合が崩れる)

## Grouping rules

- **自動生成ファイル**(`package-lock.json`, `yarn.lock` 等)は 1 行にまとめてよい:
  ```
  package-lock.json, pnpm-lock.yaml: 依存関係の lock を更新
  ```
- **純粋な空白・フォーマット変更のみ**の複数ファイルは 1 行にまとめてよい:
  ```
  docs/*.md: Prettier によるフォーマット統一
  ```
- ただし、ロジック変更とフォーマット変更を同じコミットに混ぜない(レビューしにくい)。

## Why this convention

1. **高速な履歴スキャン** — 日本語要約で `git log` を読む時間を短縮
2. **漏れ防止** — 各ファイルに向き合うため、意図しないステージングに気づく
3. **`git log --stat` との補完性** — 変更量と意図が同じ画面で見える
4. **レビューしやすさ** — PR でも per-file 意図が一目で分かる

## When committing

- Staged files を `git status --short` で確認
- 各ファイルの変更を `git diff --cached -- <file>` で確認しながら要約を書く
- `git commit -m` ではなく、本文を正しく改行できる HEREDOC 形式を使う:
  ```bash
  git commit -m "$(cat <<'EOF'
  Subject here

  path/to/a.js: 変更内容の1行要約
  path/to/b.md: 変更内容の1行要約
  EOF
  )"
  ```
