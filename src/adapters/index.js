//! 适配器注册表：挑出当前页面该用哪个适配器，并把「取文字」这件事统一成一步。

import * as youtube from './youtube.js';
import * as bilibili from './bilibili.js';
import * as generic from './generic.js';
import { parseSubtitle, parseBilibili, normalizeChapters, languageLabel } from '../core/subtitles.js';
import { SOURCE } from '../core/model.js';

const ADAPTERS = [youtube, bilibili, generic];

/** 当前页面的适配器（generic 永远匹配，所以一定会有结果）。 */
export function pickAdapter(loc = location) {
  return ADAPTERS.find((a) => a.matches(loc)) ?? generic;
}

export function adapterFor(siteId) {
  return ADAPTERS.find((a) => a.id === siteId) ?? generic;
}

export function siteLabel(siteId) {
  return adapterFor(siteId).label;
}

/**
 * 拉取字幕轨文本并解析。
 *
 * 用内容脚本自己的 fetch：YouTube 的 timedtext 与 b 站的 subtitle_url 都在
 * 页面同源/同站点范围内，cookie 与 Referer 天然正确，也不需要额外 host 权限。
 * LLM 与 ASR 的请求才走后台服务 worker——那个必须绕开页面的 CSP。
 *
 * @param {object} track  由 adapter.tracks() 给出
 * @returns {Promise<import('../core/model.js').TranscriptEvent[]>}
 */
export async function readTrack(track) {
  // 页面已经把字幕解析进 textTracks 的情况，直接用，不发请求
  if (Array.isArray(track?.inlineCues)) {
    return parseSubtitle(
      track.inlineCues
        .map((c) => `${msToStamp(c.start)} --> ${msToStamp(c.end)}\n${c.text}\n`)
        .join('\n'),
    );
  }
  if (!track?.fetch?.url) return [];

  const res = await fetch(track.fetch.url, {
    credentials: 'include',
    headers: { Accept: '*/*' },
  });
  if (!res.ok) {
    throw new Error(`取字幕失败（HTTP ${res.status}）`);
  }
  const text = await res.text();
  // b 站的字幕是自带 body[].from/to/content 的 JSON，走专用解析器
  if (track.fetch.as === 'json' || text.trimStart().startsWith('{')) {
    const asBili = parseBilibili(text);
    if (asBili.length) return asBili;
  }
  return parseSubtitle(text);
}

function msToStamp(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`;
}

/**
 * 按语言偏好挑一条字幕轨。
 *
 * 优先级：用户指定语言 > 页面语言 > 中文 > 英语 > 人工字幕优于自动字幕。
 * 这与 course2md 的 sort_tracks 是同一套取向。
 *
 * @param {object[]} tracks
 * @param {{preferLang?:string, allowAuto?:boolean, pageLang?:string}} opts
 */
export function pickTrack(tracks, opts = {}) {
  const usable = (tracks ?? []).filter((t) => t && (t.fetch?.url || t.inlineCues?.length));
  if (!usable.length) return null;

  const prefer = normalizeLang(opts.preferLang);
  const pageLang = normalizeLang(opts.pageLang);
  const allowAuto = opts.allowAuto !== false;

  const rank = (t) => {
    const lang = normalizeLang(t.language);
    let score = 0;
    if (prefer && lang.startsWith(prefer)) score -= 1000;
    if (pageLang && lang.startsWith(pageLang)) score -= 500;
    if (lang.startsWith('zh')) score -= 300;
    else if (lang.startsWith('en')) score -= 200;
    if (t.kind === 'manual') score -= 50;
    if (t.kind === 'automatic') score += allowAuto ? 0 : 10_000;
    if (t.inlineCues?.length) score -= 20;
    return score;
  };

  return [...usable].sort((a, b) => rank(a) - rank(b))[0];
}

function normalizeLang(code) {
  return String(code ?? '').trim().toLowerCase().replace('_', '-');
}

/** 轨道的展示名（下拉里用）。 */
export function trackLabel(track) {
  const parts = [languageLabel(track.language)];
  if (track.label && track.label !== track.language) parts.push(track.label);
  if (track.kind === 'automatic') parts.push('自动生成');
  return parts.filter(Boolean).join(' · ');
}

export { SOURCE, normalizeChapters };
