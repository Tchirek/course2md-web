/** @typedef {Partial<chrome.cookies.Cookie>} Cookie 浏览器给的 cookie（测试里是普通对象） */

/**
 * 只把当前 YouTube / B 站页面可用的 cookie 交给本机 yt-dlp（Netscape cookie 文件格式）。
 * @param {string} sourceUrl
 * @param {Cookie[]} cookies
 */
export function cookieFileFor(sourceUrl, cookies) {
  let host;
  try { host = new URL(sourceUrl).hostname.toLowerCase(); } catch { return ''; }
  const root = host === 'youtube.com' || host.endsWith('.youtube.com') ? 'youtube.com'
    : host === 'bilibili.com' || host.endsWith('.bilibili.com') ? 'bilibili.com' : '';
  if (!root) return '';

  const lines = [];
  for (const cookie of cookies) {
    const bareDomain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
    if (bareDomain !== root && !bareDomain.endsWith(`.${root}`)) continue;
    if (![cookie.name, cookie.value, cookie.path].every((value) => typeof value === 'string' && !/[\t\r\n]/.test(value))) continue;
    const domain = cookie.hostOnly ? bareDomain : `.${bareDomain}`;
    const expiry = Number.isFinite(cookie.expirationDate) ? Math.floor(Number(cookie.expirationDate)) : 0;
    lines.push(`${cookie.httpOnly ? '#HttpOnly_' : ''}${domain}\t${cookie.hostOnly ? 'FALSE' : 'TRUE'}\t${cookie.path}\t${cookie.secure ? 'TRUE' : 'FALSE'}\t${expiry}\t${cookie.name}\t${cookie.value}`);
  }
  return lines.length ? `# Netscape HTTP Cookie File\r\n${lines.join('\r\n')}\r\n` : '';
}

/**
 * 把指定 URL 应携带的 cookie 拼成 Cookie 头。
 * MV3 后台 fetch 的跨源 SameSite 规则可能丢掉 SESSDATA（已登录却被判未登录），
 * 所以像 yutto 那样由请求方显式自备登录态，不依赖浏览器自动附带。
 * @param {string} sourceUrl
 * @param {Cookie[]} cookies
 */
export function cookieHeaderFor(sourceUrl, cookies) {
  let host;
  try { host = new URL(sourceUrl).hostname.toLowerCase(); } catch { return ''; }
  const pairs = [];
  for (const cookie of cookies) {
    const bareDomain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
    if (bareDomain !== host && !host.endsWith(`.${bareDomain}`)) continue;
    if (typeof cookie.name !== 'string' || !cookie.name || typeof cookie.value !== 'string') continue;
    if (/[\s;,\\]/.test(cookie.name) || /[\s;,\\]/.test(cookie.value)) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join('; ');
}
