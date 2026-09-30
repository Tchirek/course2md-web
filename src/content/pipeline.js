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
 * 文字从哪来、取了多少。两条管线各填自己知道的字段。
 * @typedef {object} PipelineStats
 * @property {string} source          'subtitle' | 'asr'
 * @property {string} trackLabel      字幕轨或模型的名字
 * @property {number} eventCount
 * @property {number} [trackCount]    平台字幕：共有几条轨
 * @property {number} [chunkCount]    转录：切了几片
 * @property {number} [capturedSeconds] 转录：实际录到的秒数
 * @property {string} [captureMode]   转录：local-helper / offline / realtime
 */

/**
 * @typedef {object} PipelineResult
 * @property {import('../core/format.js').DocSection[]} sections 直接用于渲染面板的分节
 * @property {import('../core/model.js').Segment[]} segments 平坦段落列表（与 sections 里的对象是同一批引用）
 * @property {number[]} sectionIndexOf 段落の添字 -> 節の添字
 * @property {{title: string, t: number}[]} [chapters] プラットフォームの章
 * @property {PipelineStats} stats
 * @property {string[]} warnings 需要如实告诉用户的问题
 */

/** @typedef {{message?: string, ratio?: number, currentSec?: number, totalSec?: number}} ProgressInfo 进度的附带信息 */

/**
 * 两条管线共用的参数。
 * @typedef {object} PipelineArgs
 * @property {import('../adapters/index.js').Adapter} adapter
 * @property {import('../adapters/index.js').VideoMeta} meta
 * @property {import('../core/settings.js').Settings} settings
 * @property {(stage:string, info?:ProgressInfo)=>void} [onProgress]
 * @property {AbortSignal} [signal]
 * @property {(events:import('../core/model.js').TranscriptEvent[])=>void} [onPartial] 转录途中把已得到的事件依次交出（仅转录用）
 */

/**
 * 取平台字幕并组织成文档。
 *
 * @param {PipelineArgs} args
 * @returns {Promise<PipelineResult>}
 */
export async function runSubtitlePipeline({ adapter, meta, settings, onProgress, signal }) {
  /** @type {string[]} */
  const warnings = [];
  onProgress?.('tracks', { message: '正在查找字幕轨' });

  const tracks = await adapter.tracks(meta, { onProgress: (message) => onProgress?.('tracks', { message }) });
  if (!tracks.length) {
    throw new MissingSourceError('这个页面没有可用的字幕。', { brief: '这个视频没有平台字幕' });
  }

  const remaining = [...tracks];
  let track;
  /** @type {import('../core/model.js').TranscriptEvent[]} */
  let events = [];
  let lastError = '';
  let mismatched = false;
  while ((track = pickTrack(remaining, {
    preferLang: settings.subtitle.preferLang,
    allowAuto: settings.subtitle.allowAuto,
    pageLang: meta.language,
  }))) {
    onProgress?.('download', { message: `正在取字幕：${trackLabel(track)}` });
    try { events = await readTrack(track); } catch (error) { lastError = `字幕地址不可用：${/** @type {{message?: string}} */ (error)?.message ?? error}`; }
    // 別動画の字幕を黙って採用しない。時間軸が動画に収まらない字幕は拒否して次の候補へ
    if (overrunsDuration(events, meta.duration)) {
      lastError = `「${trackLabel(track)}」的字幕长到 ${fmtTs(events.at(-1)?.end ?? 0)}，超出视频时长 ${fmtTs(meta.duration ?? 0)}，疑似其他视频的字幕，已拒用`;
      events = [];
      mismatched = true;
    }
    if (events.length) break;
    remaining.splice(remaining.indexOf(track), 1);
  }
  // 有文字就一定是在某条轨上停下的；track 一并判断只是让类型收窄
  if (!events.length || !track) {
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
