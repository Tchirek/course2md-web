//! MAIN world 桥：读取页面自己的全局对象，并把结果回传给内容脚本。
//!
//! 为什么需要它：`ytInitialPlayerResponse` / `__INITIAL_STATE__` 定义在页面的
//! JS 世界里，隔离世界（isolated world）读不到。声明一个 `world: "MAIN"` 的
//! 内容脚本是最干净的拿法——比注入 <script> 标签省事，也不受页面 CSP 影响。
//!
//! 本文件**只读**：不写页面变量、不发网络请求、不改播放器状态（seek 除外，
//! 那是用户点时间戳时明确要求的动作）。页面对这套消息完全可见，这不是问题：
//! 能拿到的信息本来就是页面自己的。

const CHANNEL = 'c2md-page';

const handlers = {
  /** YouTube 的播放器响应：字幕轨、章节、标题作者时长都在里面。 */
  'yt.playerResponse'() {
    const player = document.querySelector('#movie_player');
    if (!player || typeof player.getPlayerResponse !== 'function') return null;
    try {
      return player.getPlayerResponse();
    } catch {
      return null;
    }
  },

  /** 用播放器自己的 API 跳转，比直接改 video.currentTime 更稳。 */
  'yt.seek'([seconds]) {
    const player = document.querySelector('#movie_player');
    if (!player || typeof player.seekTo !== 'function') return false;
    try {
      player.seekTo(Number(seconds), true);
      return true;
    } catch {
      return false;
    }
  },

  'yt.currentTime'() {
    const player = document.querySelector('#movie_player');
    if (!player || typeof player.getCurrentTime !== 'function') return null;
    try {
      return player.getCurrentTime();
    } catch {
      return null;
    }
  },

  /** B 站的初始状态：视频信息、cid、分 P 都在里面。 */
  'bili.initialState'() {
    return typeof window.__INITIAL_STATE__ === 'object' ? window.__INITIAL_STATE__ : null;
  },

  /** 一些较新的页面把播放信息放在 playinfo 里。 */
  'bili.playinfo'() {
    return typeof window.__playinfo__ === 'object' ? window.__playinfo__ : null;
  },
};

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;
  // 後から読み込まれた内容スクリプトの問い合わせ：document_start の ready を取り逃がしている
  if (data.dir === 'hello') {
    window.postMessage({ channel: CHANNEL, dir: 'ready' }, '*');
    return;
  }
  if (data.dir !== 'req') return;
  const handler = handlers[data.method];
  let value = null;
  try {
    value = handler ? handler(data.args ?? []) : null;
  } catch {
    value = null;
  }
  window.postMessage(
    { channel: CHANNEL, dir: 'res', id: data.id, value },
    '*',
  );
});

// 内容脚本靠这个标记判断桥是否就绪，避免在 document_start 之前抢先发消息
window.postMessage({ channel: CHANNEL, dir: 'ready' }, '*');
