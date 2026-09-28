//! B 站适配器：元信息、字幕轨、章节（看点）、跳转。
//!
//! 字幕要走 `x/player/v2` 接口，而且这个接口对 Referer/登录态敏感。
//! 所以字幕请求用**内容脚本自己的 fetch**（源就是 b 站，Referer 与 cookie 天然正确），
//! 不走后台服务 worker——后台的 Origin 是 chrome-extension://，容易被接口拒。

import { readInlineJson } from '../core/json.js';
import { callPage } from './bridge.js';

export const id = 'bilibili';
export const label = '哔哩哔哩';

const API = 'https://api.bilibili.com/x/player/v2';

/** @param {Location} loc */
export function matches(loc) {
  return /(^|\.)bilibili\.com$/.test(loc.hostname) && loc.pathname.startsWith('/video/');
}

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
  const url = `https://www.bilibili.com/video/${bvid}`;

  if (data) {
    return {
      title: String(data.title ?? '').trim() || document.title,
      uploader: String(data.owner?.name ?? '').trim(),
      duration: Number(data.duration) || Number(video()?.duration) || 0,
      url,
      site: id,
      language: '',
      videoId: bvid,
      // 交给下游拼接口用，不属于展示信息
      aid: Number(data.aid) || Number(state?.aid) || 0,
      cid: Number(state?.cid) || Number(data.cid) || 0,
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

/** 播放器接口返回的 subtitle 与 view_points；失败时返回 null 而不是抛。 */
async function playerV2(info) {
  if (!info.aid || !info.cid) return null;
  try {
    const res = await fetch(`${API}?aid=${info.aid}&cid=${info.cid}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.code === 0 ? json.data : null;
  } catch {
    // 跨域被拦、网络不可用、未登录都走这里；由 UI 提示用户改用本地转录
    return null;
  }
}

export async function tracks(info) {
  const data = await playerV2(info ?? {});
  const list = data?.subtitle?.subtitles;
  if (!Array.isArray(list)) return [];

  return list
    .filter((t) => t && typeof t.subtitle_url === 'string' && t.subtitle_url)
    .map((t, i) => ({
      id: String(t.id ?? t.lan ?? i),
      language: String(t.lan ?? ''),
      label: String(t.lan_doc ?? t.lan ?? `字幕 ${i + 1}`),
      kind: t.type === 0 ? 'manual' : t.type === 1 ? 'automatic' : 'unknown',
      // subtitle_url 常以 // 开头，补上协议
      fetch: { url: t.subtitle_url.startsWith('//') ? `https:${t.subtitle_url}` : t.subtitle_url, as: 'json' },
    }));
}

/** 章节 = 视频看点（view_points）。 */
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
    .filter(Boolean);
}

export function video() {
  return (
    document.querySelector('.bpx-player-video-wrap video') ??
    document.querySelector('#bilibili-player video') ??
    document.querySelector('video')
  );
}

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
