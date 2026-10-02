//! B 站适配器：元信息、字幕轨、章节（看点）、跳转。
//!
//! 字幕は /x/player/wbi/v2 だけから取る（yutto と同じ）。字幕 JSON には動画を示す
//! 情報がなく、内容の帰属は取得元の API でしか担保できない。
//! /x/player/v2 はログイン中でも字幕 URL の auth_key が他動画の字幕を指すことが多く
//! （実測で正しいのは約 3 分の 1。パスは本動画の aid+cid のままで、見分けがつかない）、
//! 字幕には使わない。Protobuf の /x/v2/subtitle/web/view も暗号化された配信先で
//! 帰属を検証できないため使わない。
//! 请求从 B 站页面的内容脚本发出，保留浏览器登录态。

import { MissingSourceError } from '../core/errors.js';
import { readInlineJson } from '../core/json.js';
import { callPage } from './bridge.js';

export const id = 'bilibili';
export const label = '哔哩哔哩';

const API = 'https://api.bilibili.com/x/player/v2';

/**
 * B 站接口的 JSON（或二进制）。格式是 B 站的内部格式，不给它定类型，读的地方都用可选链兜底。
 * @param {string} url
 * @param {boolean} [binary]
 * @returns {Promise<any>}
 */
async function biliFetch(url, binary = false) {
  try {
    const response = await fetch(url, { credentials: 'include', headers: { Accept: binary ? 'application/octet-stream' : 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return binary ? new Uint8Array(await response.arrayBuffer()) : await response.json();
  } catch (error) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw error;
    const reply = await chrome.runtime.sendMessage({ type: 'subtitle.fetch', payload: { url, binary } });
    if (!reply?.ok) throw new Error(reply?.error || String(error));
    return binary ? Uint8Array.from(reply.value) : JSON.parse(reply.value);
  }
}

/** @param {Location} loc */
export function matches(loc) {
  return /(^|\.)bilibili\.com$/.test(loc.hostname) && loc.pathname.startsWith('/video/');
}

/** @param {Location} loc */
function bvidFrom(loc) {
  const m = loc.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
  return m ? m[1] : '';
}

/** 初始状态：优先读 MAIN world 的全局变量，兜底解析脚本标签。 */
async function initialState() {
  const viaBridge = await callPage('bili.initialState');
  if (viaBridge && (viaBridge.videoData || viaBridge.cid)) return viaBridge;

  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent;
    if (!text || !text.includes('__INITIAL_STATE__')) continue;
    const value = readInlineJson(text, '__INITIAL_STATE__');
    if (value?.videoData) return value;
  }
  return null;
}

export async function meta() {
  const state = await initialState();
  const data = state?.videoData;
  const bvid = bvidFrom(location);
  const part = new URLSearchParams(location.search).get('p');
  const number = /^[1-9]\d*$/.test(part ?? '') ? Number(part) : 1;
  const url = `https://www.bilibili.com/video/${bvid}${/^[1-9]\d*$/.test(part ?? '') || data?.pages?.length > 1 ? `?p=${number}` : ''}`;

  if (data) {
    const selected = data.pages?.[number - 1];
    const title = String(data.title ?? '').trim() || document.title;
    return {
      title: data.pages?.length > 1 ? `${title} · ${selected?.part || `第 ${number} 节`}` : title,
      uploader: String(data.owner?.name ?? '').trim(),
      duration: Number(selected?.duration) || Number(video()?.duration) || Number(data.duration) || 0,
      url,
      site: id,
      language: '',
      videoId: bvid,
      // 交给下游拼接口用，不属于展示信息
      aid: Number(data.aid) || Number(state?.aid) || 0,
      cid: Number(selected?.cid) || Number(state?.cid) || Number(data.cid) || 0,
    };
  }

  return {
    title: document.title.replace(/\s*_哔哩哔哩.*$/, '').trim(),
    uploader: document.querySelector('.up-name, .up-info--name')?.textContent?.trim() ?? '',
    duration: Number(video()?.duration) || 0,
    url,
    site: id,
    language: '',
    videoId: bvid,
    aid: 0,
    cid: 0,
  };
}

/**
 * 播放器接口返回的 subtitle 与 view_points；失败时返回 null 而不是抛。
 * @param {import('./index.js').VideoMeta} info
 * @returns {Promise<any>}
 */
async function playerV2(info) {
  if (!info.aid || !info.cid) return null;
  try {
    const json = await biliFetch(`${API}?aid=${info.aid}&cid=${info.cid}`);
    return json?.code === 0 ? json.data : null;
  } catch {
    // 跨域被拦、网络不可用、未登录都走这里；由 UI 提示用户改用本地转录
    return null;
  }
}

/**
 * @param {import('./index.js').VideoMeta} info
 * @returns {Promise<import('./index.js').VideoMeta>}
 */
async function subtitleInfo(info) {
  if (!info.videoId) return info;
  try {
    const data = (await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(info.videoId)}`))?.data;
    const page = Number(new URL(info.url ?? location.href).searchParams.get('p')) || 1;
    return { ...info, aid: Number(data?.aid) || info.aid || 0, cid: Number(data?.pages?.[page - 1]?.cid ?? data?.cid) || info.cid || 0 };
  } catch { return info; }
}

/** @param {import('./index.js').VideoMeta} info */
async function subtitleTracks(info) {
  const query = new URLSearchParams({ aid: String(info.aid), bvid: info.videoId ?? '', cid: String(info.cid) });
  let json;
  try {
    json = await biliFetch(`https://api.bilibili.com/x/player/wbi/v2?${query}`);
  } catch (error) {
    // 「字幕なし」と混同させない。代わりの取得元はないので理由をそのまま伝える
    throw new MissingSourceError(`B 站字幕接口暂时不可用（${error instanceof Error ? error.message : error}）。`, { brief: 'B 站字幕接口暂时不可用' });
  }
  const tracks = json?.code === 0 ? json?.data?.subtitle?.subtitles : null;
  return { tracks: Array.isArray(tracks) ? tracks : [], needLogin: Boolean(json?.data?.need_login_subtitle) };
}

/**
 * @param {import('./index.js').VideoMeta} info
 * @returns {Promise<import('./index.js').Track[]>}
 */
export async function tracks(info) {
  const current = await subtitleInfo(info ?? {});
  // ページのリソース一覧にある字幕 URL は使わない。プレーヤー自身は暗号化パスで取得するため、
  // aid+cid を含む URL はこちらの取得の残りでしかなく、パスが正しくても中身は保証されない
  const { tracks: list, needLogin } = await subtitleTracks(current);

  // 字幕元数据要登录；明确告诉用户下一步，而不是让他们对着空结果猜
  if (!list.length && needLogin) {
    throw new MissingSourceError('B 站字幕要登录后才能获取。', { brief: 'B 站字幕需登录后获取' });
  }

  return list
    .filter((t) => t && typeof t.subtitle_url === 'string' && t.subtitle_url)
    .map((/** @type {any} */ t, /** @type {number} */ i) => /** @type {import('./index.js').Track} */ ({
      id: String(t.id ?? t.lan ?? i),
      language: String(t.lan ?? ''),
      label: String(t.lan_doc ?? t.lan ?? `字幕 ${i + 1}`),
      kind: String(t.lan ?? '').startsWith('ai-') || t.ai_type === 1 || t.type === 1 ? 'automatic' : t.type === 0 ? 'manual' : 'unknown',
      // subtitle_url 常以 // 开头，补上协议
      fetch: { url: t.subtitle_url.startsWith('//') ? `https:${t.subtitle_url}` : t.subtitle_url, as: 'json' },
    }))
    .filter((track, index, all) => all.findIndex((item) => item.fetch?.url === track.fetch?.url) === index);
}
/**
 * 章节 = 视频看点（view_points）。
 * @param {import('./index.js').VideoMeta} info
 */
export async function chapters(info) {
  const data = await playerV2(info ?? {});
  const points = data?.view_points;
  if (!Array.isArray(points)) return [];
  return points
    .map((p) => {
      const t = Number(p?.from);
      if (!Number.isFinite(t)) return null;
      return { title: String(p?.content ?? '').trim(), t };
    })
    .filter((c) => c !== null);
}

/** @returns {HTMLVideoElement|null} */
export function video() {
  return /** @type {HTMLVideoElement|null} */ (
    document.querySelector('.bpx-player-video-wrap video') ??
    document.querySelector('#bilibili-player video') ??
    document.querySelector('video')
  );
}

/** @param {number} seconds */
export async function seek(seconds) {
  const el = video();
  if (!el) return false;
  // b 站播放器监听 video 的 seek，直接改 currentTime 即可
  el.currentTime = seconds;
  return true;
}

export function currentTime() {
  return video()?.currentTime ?? 0;
}
