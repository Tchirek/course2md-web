//! YouTube 适配器：元信息、字幕轨、章节、跳转。

import { readInlineJson } from '../core/json.js';
import { callPage } from './bridge.js';

export const id = 'youtube';
export const label = 'YouTube';

/** @param {Location} loc */
export function matches(loc) {
  return /(^|\.)youtube\.com$/.test(loc.hostname) && loc.pathname === '/watch';
}

export function videoIdFrom(loc) {
  return new URLSearchParams(loc.search).get('v') ?? '';
}

/**
 * 拿播放器响应。两条路径：
 *  1. MAIN world 桥（SPA 跳转后仍是最新的）
 *  2. 页面里的 `ytInitialPlayerResponse` 脚本标签（桥不可用时的兜底）
 * @returns {Promise<object|null>}
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
 */
export async function tracks() {
  const pr = await playerResponse();
  const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(list)) return [];

  return list
    .filter((t) => t && typeof t.baseUrl === 'string')
    .map((t, i) => {
      const language = String(t.languageCode ?? '');
      const automatic = t.kind === 'asr';
      const name = t.name?.simpleText ?? t.name?.runs?.[0]?.text ?? '';
      return {
        id: String(t.vssId ?? t.languageCode ?? i),
        language,
        label: name || language,
        kind: automatic ? 'automatic' : 'manual',
        fetch: { url: withJson3(t.baseUrl), as: 'text' },
      };
    });
}

function withJson3(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'json3');
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
    .filter(Boolean);
}

/** 当前页面上的 video 元素。 */
export function video() {
  return document.querySelector('video.html5-main-video') ?? document.querySelector('video');
}

/** 跳转到指定秒。优先用播放器 API，失败则退回 video.currentTime。 */
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
