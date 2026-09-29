//! B 站适配器：元信息、字幕轨、章节（看点）、跳转。
//!
//! 字幕优先读播放器 JSON 接口，空轨时再读新版 Protobuf 接口。
//! 请求从 B 站页面的内容脚本发出，保留浏览器登录态。

import { readInlineJson } from '../core/json.js';
import { callPage } from './bridge.js';
import { parseWebSubtitle } from './bili-proto.js';

export const id = 'bilibili';
export const label = '哔哩哔哩';

const API = 'https://api.bilibili.com/x/player/v2';

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
  const url = `https://www.bilibili.com/video/${bvid}${/^[1-9]\d*$/.test(part ?? '') ? `?p=${part}` : ''}`;

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
      cid: Number(data.pages?.[(Number(part) || 1) - 1]?.cid) || Number(state?.cid) || Number(data.cid) || 0,
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
    const json = await biliFetch(`${API}?aid=${info.aid}&cid=${info.cid}`);
    return json?.code === 0 ? json.data : null;
  } catch {
    // 跨域被拦、网络不可用、未登录都走这里；由 UI 提示用户改用本地转录
    return null;
  }
}

async function subtitleInfo(info) {
  if (!info.videoId) return info;
  try {
    const data = (await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(info.videoId)}`))?.data;
    const page = Number(new URL(info.url).searchParams.get('p')) || 1;
    return { ...info, aid: Number(data?.aid) || info.aid || 0, cid: Number(data?.pages?.[page - 1]?.cid ?? data?.cid) || info.cid || 0 };
  } catch { return info; }
}

async function subtitleTracks(info) {
  const query = new URLSearchParams({ bvid: info.videoId, aid: String(info.aid), cid: String(info.cid) });
  for (const endpoint of ['/x/player/v2', '/x/player/wbi/v2']) {
    try {
      const json = await biliFetch(`https://api.bilibili.com${endpoint}?${query}`);
      const tracks = json?.code === 0 ? json?.data?.subtitle?.subtitles : null;
      if (Array.isArray(tracks) && tracks.length) return tracks;
    } catch { /* 尝试下一种接口 */ }
  }
  if (!info.aid) return [];
  try {
    const params = new URLSearchParams({
      oid: String(info.cid), pid: String(info.aid), context_ext: '{"video_type":1}',
      type: '1', cur_production_type: '0', preferred_language: 'ai-zh', playlist_switch: '0',
    });
    return parseWebSubtitle(await biliFetch(`https://api.bilibili.com/x/v2/subtitle/web/view?${params}`, true));
  } catch { return []; }
}

export async function tracks(info) {
  const current = await subtitleInfo(info ?? {});
  const list = await subtitleTracks(current);
  const loaded = (performance.getEntriesByType?.('resource') ?? [])
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        const url = new URL(name);
        return current.cid > 0 && ['aisubtitle.hdslb.com', 'subtitle.bilibili.com'].includes(url.hostname) &&
          url.pathname.includes(String(current.cid)) && url.protocol === 'https:';
      } catch { return false; }
    })
    .map((subtitle_url) => ({ subtitle_url, lan: 'ai-zh', lan_doc: '中文 AI', ai_type: 1 }));

  return [...list, ...loaded]
    .filter((t) => t && typeof t.subtitle_url === 'string' && t.subtitle_url)
    .map((t, i) => ({
      id: String(t.id ?? t.lan ?? i),
      language: String(t.lan ?? ''),
      label: String(t.lan_doc ?? t.lan ?? `字幕 ${i + 1}`),
      kind: String(t.lan ?? '').startsWith('ai-') || t.ai_type === 1 || t.type === 1 ? 'automatic' : t.type === 0 ? 'manual' : 'unknown',
      // subtitle_url 常以 // 开头，补上协议
      fetch: { url: t.subtitle_url.startsWith('//') ? `https:${t.subtitle_url}` : t.subtitle_url, as: 'json' },
    }))
    .filter((track, index, all) => all.findIndex((item) => item.fetch.url === track.fetch.url) === index);
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
