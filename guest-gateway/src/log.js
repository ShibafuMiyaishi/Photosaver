// guest-gateway/src/log.js
// 1 行 1 JSON のアプリケーションログ。秘密情報(合言葉・Cookie・キー)は渡さないこと。

const PREFIX = '[guest-gateway]';

/**
 * @param {'info' | 'warn' | 'error'} level
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
export function log(level, event, fields = {}) {
  const line = `${PREFIX} ${JSON.stringify({ t: new Date().toISOString(), level, event, ...fields })}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
