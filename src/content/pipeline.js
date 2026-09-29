//! 内容脚本里的编排：取文字 -> 分节 -> 分段 -> （可选）润色 -> 成文。
//!
//! 全部状态都在内容脚本里，后台只是请求代理。所以：
//!   - service worker 被浏览器回收不会丢进度；
//!   - 关掉弹窗不影响正在跑的转录；
//!   - 用户切到别的标签页，回来时进度还在。

import { fmtTs } from '../core/time.js';
import { overrunsDuration } from '../core/subtitles.js';
import { MissingSourceError, AbortError } from '../core/errors.js';
import { pickTrack, readTrack, trackLabel } from '../adapters/index.js';
import { organize, simplifyBilibili } from './organize.js';

// 各段階は別モジュールにある。既存の import 先を変えずに済むよう、ここから再輸出する
export { runAsrPipeline } from './transcribe.js';
export { polishSegments } from './polish.js';
export { organize, eventSectionIndexOf, finalize } from './organize.js';
export { MissingSourceError, AbortError };

/**
 * @typedef {object} PipelineResult
 * @property {object} [doc]      構造化文書（finalize の後にだけある）
 * @property {object[]} sections 直接用于渲染面板的分节
 * @property {object[]} segments 平坦段落列表（与 sections 里的对象是同一批引用）
 * @property {number[]} sectionIndexOf 段落の添字 -> 節の添字
 * @property {object[]} [chapters] プラットフォームの章
 * @property {object} stats      来源、轨、耗时、润色结果等
 * @property {string[]} warnings 需要如实告诉用户的问题
 */

/**
 * 取平台字幕并组织成文档。
 *
 * @param {object} args
 * @param {object} args.adapter
 * @param {object} args.meta
 * @param {object} args.settings
 * @param {(stage:string, info?:object)=>void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<PipelineResult>}
 */
export async function runSubtitlePipeline({ adapter, meta, settings, onProgress, signal }) {
  const warnings = [];
  onProgress?.('tracks', { message: '正在查找字幕轨' });

  const tracks = await adapter.tracks(meta, { onProgress: (message) => onProgress?.('tracks', { message }) });
  if (!tracks.length) {
    throw new MissingSourceError('这个页面没有可用的字幕。', { brief: '这个视频没有平台字幕' });
  }

  const remaining = [...tracks];
  let track;
  let events = [];
  let lastError = '';
  let mismatched = false;
  while ((track = pickTrack(remaining, {
    preferLang: settings.subtitle.preferLang,
    allowAuto: settings.subtitle.allowAuto,
    pageLang: meta.language,
  }))) {
    onProgress?.('download', { message: `正在取字幕：${trackLabel(track)}` });
    try { events = await readTrack(track); } catch (error) { lastError = `字幕地址不可用：${error?.message ?? error}`; }
    // 別動画の字幕を黙って採用しない。時間軸が動画に収まらない字幕は拒否して次の候補へ
    if (overrunsDuration(events, meta.duration)) {
      lastError = `「${trackLabel(track)}」的字幕长到 ${fmtTs(events.at(-1).end)}，超出视频时长 ${fmtTs(meta.duration)}，疑似其他视频的字幕，已拒用`;
      events = [];
      mismatched = true;
    }
    if (events.length) break;
    remaining.splice(remaining.indexOf(track), 1);
  }
  if (!events.length) {
    throw new MissingSourceError(lastError ? `${lastError}。` : '平台没有返回可用字幕。', {
      brief: mismatched ? '平台字幕与视频不符' : '平台字幕读取失败',
    });
  }
  if (signal?.aborted) throw new AbortError();

  await simplifyBilibili(events, adapter.id);
  const built = organize(events, meta, {});
  return {
    ...built,
    stats: {
      source: 'subtitle',
      trackLabel: trackLabel(track),
      eventCount: events.length,
      trackCount: tracks.length,
    },
    warnings,
  };
}
