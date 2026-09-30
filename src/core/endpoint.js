//! 利用者が設定する外部エンドポイントの安全確認。

/**
 * この機械の中で完結する宛先（回環アドレス）か。
 * @param {string} url
 */
export function isLoopbackUrl(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * API key を暗号化されない http で機械の外へ送る設定なら、その理由を返す。問題なければ空文字。
 * 同じ LAN の中でも平文の Bearer は盗み見られるので、回環アドレス以外は https を求める。
 * @param {string} url
 * @param {string} [apiKey]
 */
export function plaintextKeyProblem(url, apiKey) {
  if (!apiKey) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' || isLoopbackUrl(url)) return '';
  return `为保护 API key，不会通过未加密的 http 发给 ${parsed.host}。请改用 https:// 地址；本机服务（127.0.0.1、localhost）不受此限。`;
}
