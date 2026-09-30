//! YouTube 适配器：元信息、字幕轨、章节、跳转。

import { MissingSourceError } from '../core/errors.js';
import { readInlineJson } from '../core/json.js';
import { callPage } from './bridge.js';

export const id = 'youtube';
export const label = 'YouTube';

/** @param {Location} loc */
export function matches(loc) {
  return /(^|\.)youtube\.com$/.test(loc.hostname) && loc.pathname === '/watch';
}

/** @param {Location} loc */
export function videoIdFrom(loc) {
  return new URLSearchParams(loc.search).get('v') ?? '';
}

/**
 * 拿播放器响应。两条路径：
 *  1. MAIN world 桥（SPA 跳转后仍是最新的）
 *  2. 页面里的 `ytInitialPlayerResponse` 脚本标签（桥不可用时的兜底）
 * 播放器的 JSON 是 YouTube 的内部格式，不给它定类型，读的地方都用可选链兜底。
 * @returns {Promise<any>}
 */
async function playerResponse() {
  const viaBridge = await callPage('yt.playerResponse');
  if (viaBridge && viaBridge.videoDetails) return viaBridge;

  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent;
    if (!text || !text.includes('ytInitialPlayerResponse')) continue;
    const value = readInlineJson(text, 'ytInitialPlayerResponse');
    if (value?.videoDetails) return value;
  }
  return null;
}

export async function meta() {
  const pr = await playerResponse();
  const details = pr?.videoDetails;
  const url = `https://www.youtube.com/watch?v=${videoIdFrom(location)}`;

  if (details) {
    return {
      title: String(details.title ?? '').trim() || document.title,
      uploader: String(details.author ?? '').trim(),
      duration: Number(details.lengthSeconds) || Number(video()?.duration) || 0,
      url,
      site: id,
      language: '',
      videoId: String(details.videoId ?? videoIdFrom(location)),
    };
  }

  // 兜底：只靠 DOM。抓不到时长时给 0，下游会退化为不显示时长。
  return {
    title: document.title.replace(/\s*-\s*YouTube\s*$/, '').trim(),
    uploader: document.querySelector('ytd-watch-metadata #owner a')?.textContent?.trim() ?? '',
    duration: Number(video()?.duration) || 0,
    url,
    site: id,
    language: '',
    videoId: videoIdFrom(location),
  };
}

/**
 * 字幕轨。`kind === 'asr'` 是自动生成字幕。
 * baseUrl 指向 timedtext；加 `&fmt=json3` 拿 JSON（比 XML 好解析）。
 *
 * 取字幕用内容脚本自己的 fetch（同源、带 cookie），不走后台：
 * 页面就在 youtube.com，timedtext 是同源请求，不需要额外 host 权限。
 *
 * URL に exp=xpe がある字幕は pot トークンなしでは空で返る（Cookie では足りない）。
 * yt-dlp も同じ印で PO トークンの要否を判断している。トークンはページ側のブリッジが
 * プレーヤーの要求から拾い、同じ動画の全字幕に付ける。
 */
/**
 * @param {unknown} [_info]
 * @param {{onProgress?: (message: string) => void}} [options] 広告待ちなど時間のかかる段階の進捗表示
 * @returns {Promise<import('./index.js').Track[]>}
 */
export async function tracks(_info, { onProgress } = {}) {
  const pr = await playerResponse();
  const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(list)) return [];
  const usable = list.filter((t) => t && typeof t.baseUrl === 'string');
  if (!usable.length) return [];

  /** @type {Record<string, unknown>|null} */
  let token = null;
  if (usable.some(needsToken)) {
    const videoId = String(pr?.videoDetails?.videoId ?? videoIdFrom(location));
    const first = usable[0];
    if (await callPage('yt.adShowing')) onProgress?.('正在等广告播完，再读取字幕（可跳过广告）');
    // ページ側は広告が再生され続ける限り終了を待ち（最長 10 分）、その後プレーヤーに字幕を読ませる
    token = await callPage('yt.captionToken', [videoId, first.languageCode, first.kind], { timeoutMs: 630_000 });
    if (!token?.pot) {
      throw new MissingSourceError('没有取到 YouTube 字幕的访问凭证（广告被暂停或播放器尚未就绪）。', { brief: '没有取到 YouTube 字幕' });
    }
  }

  return usable
    .map((t, i) => {
      const language = String(t.languageCode ?? '');
      const automatic = t.kind === 'asr';
      const name = t.name?.simpleText ?? t.name?.runs?.[0]?.text ?? '';
      return {
        id: String(t.vssId ?? t.languageCode ?? i),
        language,
        label: name || language,
        kind: automatic ? 'automatic' : 'manual',
        fetch: { url: timedTextUrl(t.baseUrl, token), as: 'text' },
      };
    });
}

/** @param {{baseUrl: string}} track */
function needsToken(track) {
  try {
    return (new URL(track.baseUrl).searchParams.get('exp') ?? '').split(',').includes('xpe');
  } catch {
    return false;
  }
}

/**
 * @param {string} baseUrl
 * @param {Record<string, unknown>|null} token 页面桥取到的 pot 等参数
 */
function timedTextUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'json3');
  for (const [key, value] of Object.entries(token ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

/** 章节：播放器响应里的 chapters，或描述里的时间轴（由页面解析后给出）。 */
export async function chapters() {
  const pr = await playerResponse();
  const list = pr?.chapters;
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => {
      const r = c?.chapterRenderer;
      if (!r) return null;
      const ms = Number(r.timeRangeStartMillis);
      if (!Number.isFinite(ms)) return null;
      return {
        title: String(r.title?.simpleText ?? '').trim(),
        t: ms / 1000,
      };
    })
    .filter((c) => c !== null);
}

/** 当前页面上的 video 元素。 */
/** @returns {HTMLVideoElement|null} */
export function video() {
  return /** @type {HTMLVideoElement|null} */ (document.querySelector('video.html5-main-video')) ?? document.querySelector('video');
}

/**
 * 跳转到指定秒。优先用播放器 API，失败则退回 video.currentTime。
 * @param {number} seconds
 */
export async function seek(seconds) {
  const ok = await callPage('yt.seek', [seconds]);
  if (ok) return true;
  const el = video();
  if (!el) return false;
  el.currentTime = seconds;
  return true;
}

export function currentTime() {
  return video()?.currentTime ?? 0;
}
