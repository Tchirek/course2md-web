//! 扩展在生成途中被重新加载时，让生成在页面刷新后接着进行。
//!
//! 重新加载后旧的内容脚本就与扩展断开了，而扩展不会往已打开的页面里补注入，所以只能
//! 刷新页面。待续的请求放在页面的 sessionStorage：只属于这个标签页，刷新后还在，
//! 且不依赖已断开的扩展接口。

const CHECK_TIMEOUT_MS = 4000;
const RESUME_KEY = 'c2md.resumeRun';
const RESUME_TTL_MS = 120_000;

/**
 * 嵌一个隐藏的扩展页面（src/ui/freshness.js）检查后台是否还是旧代码，旧就由它重载扩展。
 * @returns {Promise<boolean>} 是否正在重载
 */
export function ensureFreshCode() {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/ui/freshness.html');
    frame.style.cssText = 'display:none';
    frame.setAttribute('aria-hidden', 'true');
    const finish = (reloading) => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      frame.remove();
      resolve(reloading);
    };
    const onMessage = (event) => {
      if (event.source === frame.contentWindow && event.data?.channel === 'c2md-freshness') finish(Boolean(event.data.reloading));
    };
    // 拿不到答复（页面策略拦了框架等）就照常继续，不因检查本身耽误生成
    const timer = setTimeout(() => finish(false), CHECK_TIMEOUT_MS);
    addEventListener('message', onMessage);
    (document.body ?? document.documentElement).appendChild(frame);
  });
}

/** 本内容脚本是否已与扩展断开（扩展被重新加载、更新或停用）。 */
export function extensionGone() {
  return !globalThis.chrome?.runtime?.id;
}

/**
 * 记下待续的生成请求，等扩展重载完就刷新本页，由新的内容脚本接着生成。
 * @param {{ page: string, overrides?: object }} request
 */
export function resumeAfterExtensionReload(request) {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...request, at: Date.now() }));
  } catch { /* 存不下就只刷新，由用户再点一次 */ }
  const started = Date.now();
  const timer = setInterval(() => {
    const gone = extensionGone();
    if (!gone && Date.now() - started < 10_000) return;
    clearInterval(timer);
    // 断开后稍等新扩展起来，刷新时才会注入新的内容脚本
    setTimeout(() => location.reload(), gone ? 800 : 0);
  }, 200);
}

/** 取出属于本页、仍在有效期内的待续请求，取出即删。 */
export function takeResumeRequest(page) {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(RESUME_KEY);
    const request = JSON.parse(raw);
    return request?.page === page && Date.now() - request.at < RESUME_TTL_MS ? request : null;
  } catch {
    return null;
  }
}
