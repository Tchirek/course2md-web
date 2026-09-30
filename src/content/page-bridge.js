//! MAIN world 桥：读取页面自己的全局对象，并把结果回传给内容脚本。
//!
//! 为什么需要它：`ytInitialPlayerResponse` / `__INITIAL_STATE__` 定义在页面的
//! JS 世界里，隔离世界（isolated world）读不到。声明一个 `world: "MAIN"` 的
//! 内容脚本是最干净的拿法——比注入 <script> 标签省事，也不受页面 CSP 影响。
//!
//! 本文件**只读**：不写页面变量、不发网络请求、不改播放器状态（seek 除外，
//! 那是用户点时间戳时明确要求的动作）。页面对这套消息完全可见，这不是问题：
//! 能拿到的信息本来就是页面自己的。
//!
//! 例外が一つある：YouTube の字幕トークン（下の yt.captionToken）。まだ無ければ
//! プレーヤーに字幕を一度読み込ませ、トークンを拾ったら字幕の表示状態を元に戻す。

const CHANNEL = 'c2md-page';

// YouTube の timedtext は URL に exp=xpe があると、pot（proof of origin トークン）
// なしでは 200 の空応答を返す（手動字幕も自動字幕も）。トークンはプレーヤーしか
// 作れないので、プレーヤー自身が字幕を取りに行った URL から動画ごとに拾っておく。
// 同じ動画のトークンは全言語・全種類の字幕に使える。YouTube はリソースタイミングの
// バッファを消すことがあるため、後から一覧を読むのではなく observer で受け取る。
const captionTokens = new Map();
const TOKEN_PARAMS = ['pot', 'potc', 'c', 'cver'];

function noteCaptionRequest(name) {
  if (!name.includes('/api/timedtext')) return;
  try {
    const url = new URL(name);
    const video = url.searchParams.get('v');
    if (!video || !url.searchParams.get('pot')) return;
    captionTokens.set(video, Object.fromEntries(
      TOKEN_PARAMS.filter((key) => url.searchParams.has(key)).map((key) => [key, url.searchParams.get(key)]),
    ));
  } catch { /* 解析できない URL は無視 */ }
}

if (/(^|\.)youtube\.com$/.test(location.hostname)) {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) noteCaptionRequest(entry.name);
    }).observe({ type: 'resource', buffered: true });
  } catch { /* observer が使えなければトークンなしで進む */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const handlers = {
  /** YouTube 的播放器响应：字幕轨、章节、标题作者时长都在里面。 */
  'yt.playerResponse'() {
    const player = /** @type {YouTubePlayerElement|null} */ (document.querySelector('#movie_player'));
    if (!player || typeof player.getPlayerResponse !== 'function') return null;
    try {
      return player.getPlayerResponse();
    } catch {
      return null;
    }
  },

  /** 用播放器自己的 API 跳转，比直接改 video.currentTime 更稳。 */
  'yt.seek'([seconds]) {
    const player = /** @type {YouTubePlayerElement|null} */ (document.querySelector('#movie_player'));
    if (!player || typeof player.seekTo !== 'function') return false;
    try {
      player.seekTo(Number(seconds), true);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * 動画の字幕トークン。無ければプレーヤーに字幕を読み込ませて拾い、読み込み前の
   * 字幕状態（オフ、または選んでいた言語）に戻す。取れなければ null。
   */
  async 'yt.captionToken'([videoId, languageCode, kind]) {
    if (captionTokens.has(videoId)) return captionTokens.get(videoId);
    const player = /** @type {YouTubePlayerElement|null} */ (document.querySelector('#movie_player'));
    if (typeof player?.getPlayerResponse !== 'function' || typeof player.setOption !== 'function') return null;
    // トークンは動画に束縛される（別動画のトークンでは空応答）。広告の再生中は本編の
    // 字幕をプレーヤーが取りに行かないので、広告が終わるまで待つ。広告は連続することが
    // あり（実測：56 秒の広告の直後に次の広告）、固定の上限では足りない。再生が進んで
    // いる限り待ち、15 秒止まったら（一時停止など）または計 10 分で諦める。数分の
    // スキップ可能な広告もあるので、待っている間は「スキップできる」と案内する
    const adShowing = () => player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    const started = Date.now();
    let lastTime = NaN;
    let movedAt = started;
    while (adShowing() && !captionTokens.has(videoId)) {
      const time = player.querySelector('video')?.currentTime;
      if (time !== lastTime) {
        lastTime = time;
        movedAt = Date.now();
      }
      if (Date.now() - movedAt > 15_000 || Date.now() - started > 600_000) break;
      await sleep(200);
    }
    if (captionTokens.has(videoId)) return captionTokens.get(videoId);
    if (adShowing() || player.getPlayerResponse()?.videoDetails?.videoId !== videoId) return null;
    let previous = null;
    try { previous = player.getOption?.('captions', 'track') ?? null; } catch { /* 字幕モジュール未読込 */ }
    try {
      player.loadModule?.('captions');
      player.setOption('captions', 'track', { languageCode, kind });
      for (let i = 0; i < 60 && !captionTokens.has(videoId); i++) await sleep(100);
    } catch { /* 取れなかった */ } finally {
      try {
        if (previous?.languageCode) player.setOption('captions', 'track', previous);
        else player.unloadModule?.('captions');
      } catch { /* 元に戻せなくても字幕表示が残るだけ */ }
    }
    return captionTokens.get(videoId) ?? null;
  },

  /** 広告の再生中か（字幕トークンの取得が広告終了待ちになるかの判断に使う）。 */
  'yt.adShowing'() {
    const player = /** @type {YouTubePlayerElement|null} */ (document.querySelector('#movie_player'));
    return Boolean(player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting'));
  },

  'yt.currentTime'() {
    const player = /** @type {YouTubePlayerElement|null} */ (document.querySelector('#movie_player'));
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
  // 只认自己的方法：不调用 toString、constructor 等 Object.prototype 上的东西
  const handler = Object.hasOwn(handlers, data.method) ? handlers[data.method] : null;
  // 非同期の handler（yt.captionToken）も同じ経路で返す
  Promise.resolve()
    .then(() => (handler ? handler(data.args ?? []) : null))
    .catch(() => null)
    .then((value) => window.postMessage({ channel: CHANNEL, dir: 'res', id: data.id, value: value ?? null }, '*'));
});

// 内容脚本靠这个标记判断桥是否就绪，避免在 document_start 之前抢先发消息
window.postMessage({ channel: CHANNEL, dir: 'ready' }, '*');
