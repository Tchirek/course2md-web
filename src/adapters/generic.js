//! 通用适配器：任何页面上有 <video> 就能用。
//! 覆盖 course2md 的「本地录制」场景——在浏览器里打开本地视频文件也走这条路径。
//!
//! 字幕来源只有标准 `<track>`（外挂 VTT/SRT）与浏览器已经解析出来的 textTracks。
//! 没有平台字幕时，用户应该切到「本地模型转录」。

import { parseChaptersVtt } from '../core/subtitles.js';

export const id = 'generic';
export const label = '通用页面';

/** 兜底适配器：永远匹配。 */
export function matches() {
  return true;
}

export function video() {
  // 页面里可能有多个 video（广告、预览），挑最可能正在播的那个
  const all = [...document.querySelectorAll('video')];
  if (!all.length) return null;
  const playing = all.find((v) => !v.paused && !v.ended && v.readyState > 2);
  if (playing) return playing;
  const largest = all
    .map((v) => ({ v, area: (v.clientWidth || 0) * (v.clientHeight || 0) }))
    .sort((a, b) => b.area - a.area)[0];
  return largest?.v ?? null;
}

export async function meta() {
  const el = video();
  const ogTitle = /** @type {HTMLMetaElement|null} */ (document.querySelector('meta[property="og:title"]'))?.content ?? '';
  const ogAuthor = /** @type {HTMLMetaElement|null} */ (document.querySelector('meta[name="author"]'))?.content ?? '';
  const duration = Number(el?.duration);
  return {
    title: (ogTitle || document.title || '').trim() || '未命名视频',
    uploader: ogAuthor.trim(),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    url: location.href,
    site: id,
    language: String(el?.getAttribute('lang') ?? document.documentElement.lang ?? ''),
    videoId: '',
  };
}

/**
 * `<track>` 元素。带 `src` 的可以直接取；已有 cues 的（同一页面里播放器解析过的）
 * 由内容脚本本地读取，不需要网络。
 */
export async function tracks() {
  const el = video();
  if (!el) return [];

  const out = [];
  const seen = new Set();

  // 1. 已解析到 cues 的 textTrack（播放器已经把字载进来了，最省事）
  const textTracks = [...(el.textTracks ?? [])];
  for (let i = 0; i < textTracks.length; i++) {
    const tt = textTracks[i];
    if (!tt || !['subtitles', 'captions'].includes(tt.kind)) continue;
    const cues = tt.cues;
    if (!cues || !cues.length) continue;
    if (seen.has(tt.language + tt.label)) continue;
    seen.add(tt.language + tt.label);
    out.push({
      id: `live-${i}`,
      language: tt.language || '',
      label: tt.label || tt.language || `字幕 ${i + 1}`,
      kind: 'unknown',
      inlineCues: [...cues].map((c) => ({
        start: c.startTime,
        end: c.endTime,
        text: /** @type {VTTCue} */ (c).text,
      })),
      fetch: null,
    });
  }

  // 2. `<track src>`：交给调用方去取文本
  for (const track of el.querySelectorAll('track')) {
    const src = track.getAttribute('src');
    if (!src) continue;
    const kind = track.getAttribute('kind') ?? '';
    if (kind === 'chapters') continue;
    const language = track.getAttribute('srclang') ?? '';
    const label = track.getAttribute('label') ?? '';
    const key = `${language}|${label}|${src}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `track-${out.length}`,
      language,
      label: label || language || `外挂字幕 ${out.length + 1}`,
      kind: track.hasAttribute('default') ? 'manual' : 'unknown',
      fetch: { url: new URL(src, location.href).toString(), as: 'text' },
    });
  }

  return out;
}

/** 章节轨（`<track kind="chapters">`）是标准做法，虽然少见。 */
export async function chapters() {
  const el = video();
  if (!el) return [];
  const track = el.querySelector('track[kind="chapters"]');
  if (!track) return [];

  // 浏览器已解析过就直接用
  const tt = [...(el.textTracks ?? [])].find((t) => t?.kind === 'chapters');
  if (tt?.cues?.length) {
    return [...tt.cues].map((c) => ({ title: /** @type {VTTCue} */ (c).text, t: c.startTime }));
  }

  const src = track.getAttribute('src');
  if (!src) return [];
  try {
    const res = await fetch(new URL(src, location.href).toString());
    if (!res.ok) return [];
    return parseChaptersVtt(await res.text());
  } catch {
    return [];
  }
}

/** @param {number} seconds */
export async function seek(seconds) {
  const el = video();
  if (!el) return false;
  el.currentTime = seconds;
  return true;
}

export function currentTime() {
  return video()?.currentTime ?? 0;
}
