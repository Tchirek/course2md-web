//! 内容脚本侧的桥客户端：向 MAIN world 的 page-bridge 发请求并等回复。

const CHANNEL = 'c2md-page';
const REPLY_TIMEOUT_MS = 1500;

let seq = 0;
const pending = new Map();
let ready = false;
const readyWaiters = [];

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;

  if (data.dir === 'ready') {
    ready = true;
    for (const fn of readyWaiters.splice(0)) fn();
    return;
  }
  if (data.dir !== 'res') return;

  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  clearTimeout(entry.timer);
  entry.resolve(data.value ?? null);
});

function whenReady(timeoutMs = 2000) {
  if (ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    readyWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
    // ページ側は document_start に一度だけ ready を告げる。document_idle で読み込まれる
    // こちらはそれを必ず取り逃がすので、問い合わせて ready を返してもらう
    window.postMessage({ channel: CHANNEL, dir: 'hello' }, '*');
  });
}

/**
 * 调用页面世界里的一个 handler。
 * 拿不到值时 resolve 为 null——调用方一律要有自己的兜底路径，
 * 因为桥可能不存在（比如 Firefox 不支持 `world: MAIN`）。
 *
 * @param {string} method
 * @param {unknown[]} [args]
 * @returns {Promise<any|null>}
 */
export async function callPage(method, args = []) {
  if (!(await whenReady())) return null;
  const id = `c2md-${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, REPLY_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    window.postMessage({ channel: CHANNEL, dir: 'req', id, method, args }, '*');
  });
}
