// 只把当前 YouTube / B 站页面可用的 cookie 交给本机 yt-dlp。
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
    const expiry = Number.isFinite(cookie.expirationDate) ? Math.floor(cookie.expirationDate) : 0;
    lines.push(`${cookie.httpOnly ? '#HttpOnly_' : ''}${domain}\t${cookie.hostOnly ? 'FALSE' : 'TRUE'}\t${cookie.path}\t${cookie.secure ? 'TRUE' : 'FALSE'}\t${expiry}\t${cookie.name}\t${cookie.value}`);
  }
  return lines.length ? `# Netscape HTTP Cookie File\r\n${lines.join('\r\n')}\r\n` : '';
}
