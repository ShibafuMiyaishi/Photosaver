// album-guard/src/config.js
// 環境変数読み込み + 起動時バリデータ。
// GUARD_JWT_SECRET が未設定 / placeholder / < 32 chars の場合は require() 時に throw する。
// index.js が require を try/catch で囲み process.exit(1) + 分かりやすいメッセージに変換する。

require('dotenv').config();

const PLACEHOLDER_SECRETS = new Set([
  'CHANGE_THIS_JWT_SECRET_32chars_min',
  'CHANGE_ME_32_CHAR_MIN_RANDOM_HEX_STRING',
]);

function readConfig() {
  const jwtSecret = process.env.GUARD_JWT_SECRET || '';

  if (!jwtSecret || jwtSecret.length < 32 || PLACEHOLDER_SECRETS.has(jwtSecret)) {
    const err = new Error(
      'GUARD_JWT_SECRET is missing, a placeholder, or shorter than 32 chars. ' +
        'Generate a real value with: openssl rand -hex 32',
    );
    err.code = 'INVALID_JWT_SECRET';
    throw err;
  }

  return {
    PORT: parseInt(process.env.GUARD_PORT || '3000', 10),
    IMMICH_URL: process.env.IMMICH_INTERNAL_URL || 'http://immich-server:2283',
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: process.env.GUARD_JWT_EXPIRES_IN || '24h',
    PASSWORDS_FILE: process.env.GUARD_PASSWORDS_FILE || '/app/data/album-passwords.json',
    LOG_FORMAT: process.env.GUARD_LOG_FORMAT || 'combined',
  };
}

const config = readConfig();
config.readConfig = readConfig;
module.exports = config;
