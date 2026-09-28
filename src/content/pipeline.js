//! 内容脚本里的编排：取文字 -> 分节 -> 分段 -> （可选）润色 -> 成文。
//!
//! 全部状态都在内容脚本里，后台只是请求代理。所以：
//!   - service worker 被浏览器回收不会丢进度；
//!   - 关掉弹窗不影响正在跑的转录；
//!   - 用户切到别的标签页，回来时进度还在。

import { coalesce, partitionByBoundaries } from '../core/paragraphs.js';
import { planChunks, mapPool } from '../core/chunk.js';
import { buildMessages, parsePolishResponse, applyPolish, resetPolish } from '../core/prompt.js';
import { buildDoc } from '../core/format.js';
import { fmtTs } from '../core/time.js';
import { normalizeChapters } from '../core/subtitles.js';
import { pickTrack, readTrack, trackLabel } from '../adapters/index.js';
import { captureAudio } from './capture.js';
import { decodeMediaAudio, FastAudioUnavailable } from './fast-audio.js';

/**
 * @typedef {object} PipelineResult
 * @property {object} doc        结构化文档（buildDoc 的产物）
 * @property {object[]} sections 直接用于渲染面板的分节
 * @property {object[]} segments 平坦段落列表（与 sections 里的对象是同一批引用）
 * @property {object} stats      来源、轨、耗时、润色结果等
 * @property {string[]} warnings 需要如实告诉用户的问题
 */

/** 通过后台发一次 LLM 对话请求。 */
async function llmChat(payload) {
  const reply = await chrome.runtime.sendMessage({ type: 'llm.chat', payload });
  if (!reply) throw new Error('后台没有响应（扩展可能刚被重新加载，刷新页面即可）');
  if (!reply.ok) throw new Error(reply.error ?? '请求失败');
  return reply.value;
}

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

  const tracks = await adapter.tracks(meta);
  if (!tracks.length) {
    throw new MissingSourceError(
      '这个页面没有可用的字幕。可以在「文字来源」里改成「本地模型转录」，用本机模型从音频转写。',
    );
  }

  const track = pickTrack(tracks, {
    preferLang: settings.subtitle.preferLang,
    allowAuto: settings.subtitle.allowAuto,
    pageLang: meta.language,
  });
  if (!track) throw new MissingSourceError('没有符合当前语言偏好的字幕轨。');

  onProgress?.('download', { message: `正在取字幕：${trackLabel(track)}` });
  const events = await readTrack(track);
  if (!events.length) {
    throw new MissingSourceError(
      `字幕轨「${trackLabel(track)}」是空的（平台有时会返回空字幕）。可在设置里换一条轨，或改用本地模型转录。`,
    );
  }
  if (signal?.aborted) throw new AbortError();

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

/**
 * 用本机模型转录音频再组织成文档。
 *
 * @param {object} args
 * @param {object} args.adapter
 * @param {object} args.meta
 * @param {object} args.settings
 * @param {(stage:string, info?:object)=>void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @param {(seconds:number)=>void} [args.seek]
 * @returns {Promise<PipelineResult>}
 */
export async function runAsrPipeline({ adapter, meta, settings, onProgress, signal }) {
  const warnings = [];
  const asr = settings.asr;

  const el = adapter.video();
  if (!el) throw new MissingSourceError('页面上找不到 video 元素，无法转录。');

  if (!asr.endpoint) {
    throw new MissingSourceError(
      '还没填写本机 ASR 服务的地址。到设置页的「本地模型转录」里填一个端点——' +
        'whisper.cpp 的 server、faster-whisper-server 都行，音频不出本机。',
    );
  }

  const events = [];
  let fastError = '';
  if (/^(https?:|file:)/.test(meta.url || '')) {
    onProgress?.('capture', { ratio: 0, message: '正在尝试本机快速提取音轨' });
    let fastJobId;
    try {
      const started = await chrome.runtime.sendMessage({
        type: 'asr.fast.start',
        payload: {
          sourceUrl: meta.url,
          endpoint: asr.endpoint,
          apiKey: asr.apiKey,
          model: asr.model,
          language: asr.language || meta.language || undefined,
          chunkSeconds: asr.chunkSeconds,
        },
      });
      if (!started?.ok || !started.value?.id) throw new Error(started?.error ?? '本机提取未启动');
      fastJobId = started.value.id;
      let job;
      do {
        if (signal?.aborted) throw new AbortError();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const reply = await chrome.runtime.sendMessage({ type: 'asr.fast.status', payload: { id: started.value.id } });
        if (!reply?.ok) throw new Error(reply?.error ?? '本机任务查询失败');
        job = reply.value;
        onProgress?.('capture', { ratio: job.total ? job.done / job.total : 0, message: job.message });
      } while (job.state === 'running');
      if (job.state === 'error') throw new Error(job.error);
      if (job.events?.length) {
        const built = organize(job.events, meta, {});
        return {
          ...built,
          stats: {
            source: 'asr',
            trackLabel: `${asr.model || '本机模型'} · 本机快速提取`,
            eventCount: job.events.length,
            chunkCount: job.chunks,
            captureMode: 'local-helper',
          },
          warnings,
        };
      }
    } catch (error) {
      if (signal?.aborted || error instanceof AbortError) {
        if (fastJobId) chrome.runtime.sendMessage({ type: 'asr.fast.cancel', payload: { id: fastJobId } }).catch(() => {});
        throw new AbortError();
      }
      fastError = String(error?.message ?? error);
      warnings.push(`本机快速提取失败：${fastError}`);
      // 没运行辅助服务时继续尝试浏览器可读媒体。
    }
  }
  const pending = new Set();
  let failure = null;
  const options = {
    chunkSeconds: asr.chunkSeconds,
    playbackRate: asr.playbackRate,
    signal,
    onProgress: (info) => onProgress?.('capture', { ...info, message: '正在提取并转写音频' }),
    onChunk: async (chunk, index) => {
      if (failure) throw failure;
      const task = chrome.runtime.sendMessage({
        type: 'asr.transcribe',
        payload: {
          endpoint: asr.endpoint,
          apiKey: asr.apiKey,
          model: asr.model,
          language: asr.language || meta.language || undefined,
          audio: bytesToBase64(new Uint8Array(await chunk.blob.arrayBuffer())),
          mimeType: chunk.blob.type,
          fileName: `chunk-${String(index).padStart(4, '0')}.${chunk.extension}`,
        },
      }).then((reply) => {
        if (!reply?.ok || !reply.value?.ok) {
          const detail = reply?.error ?? reply?.value?.error ?? '未知错误';
          throw new Error(`第 ${index} 片转写失败：${detail}`);
        }
        const value = reply.value;
        if (value.segments?.length) {
          for (const s of value.segments) {
            events.push({ start: chunk.start + s.start, end: chunk.start + s.end, text: s.text });
          }
        } else if (value.text) {
          events.push({ start: chunk.start, end: chunk.end, text: value.text });
        }
      }).catch((error) => { failure ??= error; }).finally(() => pending.delete(task));
      pending.add(task);
      if (pending.size >= 2) await Promise.race(pending);
      if (failure) throw failure;
    },
  };

  onProgress?.('capture', { ratio: 0, message: '正在离线读取音频' });
  let result;
  try {
    result = await decodeMediaAudio(el, options);
  } catch (error) {
    if (!(error instanceof FastAudioUnavailable)) throw error;
    if (fastError) {
      throw new MissingSourceError(`本机音轨提取失败：${fastError}\n浏览器也无法离线读取：${error.message}`);
    }
    const totalSec = Number(meta.duration) || Number(el.duration) || 0;
    warnings.push(`无法离线读取媒体（${error.message}），改用播放器录音。${totalSec ? `约需 ${fmtTs(totalSec / Math.max(1, asr.playbackRate))}。` : ''}`);
    onProgress?.('capture', { ratio: 0, message: '媒体无法离线读取，正在录音' });
    result = await captureAudio(el, options);
  }
  await Promise.all(pending);
  if (failure) throw failure;

  if (result.aborted) throw new AbortError();
  if (!events.length) {
    throw new MissingSourceError('转录没有产出任何文字。确认视频有声音，且本机 ASR 服务工作正常。');
  }

  const built = organize(events, meta, {});
  return {
    ...built,
    stats: {
      source: 'asr',
      trackLabel: asr.model || '本机模型',
      eventCount: events.length,
      capturedSeconds: result.seconds,
      chunkCount: result.chunks,
      captureMode: result.mode ?? 'realtime',
    },
    warnings,
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * 事件 -> 分节 -> 段落。
 *
 * 导出的文字有章节就按章节分节，没有章节就整体一节。
 * 面板的画面段落由 visual.js 单独生成。
 *
 * @param {import('../core/model.js').TranscriptEvent[]} events
 * @param {object} meta
 * @param {object} opts 传给 coalesce
 */
export function organize(events, meta, opts = {}) {
  const chapters = normalizeChapters(meta.chapters ?? []);
  const mediaEnd = Number(meta.duration) || 0;

  let sections;
  if (chapters.length) {
    sections = partitionByBoundaries(events, chapters.map((c) => c.t), {
      ...opts,
      mediaEnd,
    }).map((section, i) => ({ ...section, title: chapters[i]?.title ?? '' }));
  } else {
    sections = [{ t: 0, end: mediaEnd, title: '', segments: coalesce(events, opts) }];
  }

  // 平坦列表与 sections 里的段落共享同一批对象引用，润色就地生效
  const segments = [];
  const sectionIndexOf = [];
  sections.forEach((section, i) => {
    for (const seg of section.segments) {
      segments.push(seg);
      sectionIndexOf.push(i);
    }
  });

  return { sections, segments, sectionIndexOf, chapters };
}

/**
 * 润色。分块并行，块内 id 严格对应（详见 core/chunk.js 与 core/prompt.js 的说明）。
 *
 * @param {object} args
 * @param {object[]} args.segments 平坦段落（会被就地修改）
 * @param {number[]} args.sectionIndexOf
 * @param {object} args.meta
 * @param {object} args.settings
 * @param {(done:number,total:number)=>void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{chunks:number, polished:number, failed:number, removed:number, errors:string[]}>}
 */
export async function polishSegments({ segments, sectionIndexOf, meta, settings, onProgress, signal }) {
  resetPolish(segments);

  const llm = settings.llm;
  const chunks = planChunks(segments, {
    contextChars: llm.contextChars,
    sectionOf: (i) => sectionIndexOf?.[i] ?? 0,
  });
  if (!chunks.length) {
    return { chunks: 0, polished: 0, failed: 0, removed: 0, errors: [] };
  }

  const errors = [];
  let polished = 0;
  let removed = 0;

  const results = await mapPool(
    chunks,
    llm.concurrency,
    async (chunk) => {
      if (signal?.aborted) throw new AbortError();
      const messages = buildMessages({
        segments,
        chunk,
        meta,
        instruction: llm.instruction,
        glossary: llm.glossary,
        langHint: meta.language,
      });
      const reply = await llmChat({
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        model: llm.model,
        messages,
      });
      const parsed = parsePolishResponse(reply.content);
      const outcome = applyPolish(segments, chunk.ids, parsed);
      if (!outcome.applied) {
        throw new Error(
          parsed
            ? '模型返回的条目与请求对不上，这一块保留原文'
            : '模型没有返回可解析的 JSON，这一块保留原文',
        );
      }
      return outcome;
    },
    (done, total) => onProgress?.(done, total),
  );

  results.forEach((outcome, i) => {
    if (!outcome) {
      if (!signal?.aborted) errors.push(`第 ${i + 1}/${chunks.length} 块未润色`);
      return;
    }
    polished += outcome.applied ? 1 : 0;
    removed += outcome.removed;
  });

  return { chunks: chunks.length, polished, failed: errors.length, removed, errors };
}

/** 由 pipeline 结果生成最终文档。 */
export function finalize(built, meta, settings) {
  // stats 由两个 pipeline 各自填；这里兜一层，避免调用方少传一个字段就崩
  const source = built?.stats?.source ?? settings?.source ?? 'subtitle';
  const doc = buildDoc({ ...meta, source }, built?.sections ?? []);
  doc.meta.showTimestamps = settings.showTimestamps;
  doc.meta.clickToSeek = settings.clickToSeek;
  doc.meta.polished = Boolean(settings.polish);
  return doc;
}

/** 源缺失：用户配置问题，不是崩溃。UI 要给出可操作的下一步。 */
export class MissingSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingSourceError';
    this.actionable = true;
  }
}

export class AbortError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'AbortError';
  }
}
