//! 内容脚本里的编排：取文字 -> 分节 -> 分段 -> （可选）润色 -> 成文。
//!
//! 全部状态都在内容脚本里，后台只是请求代理。所以：
//!   - service worker 被浏览器回收不会丢进度；
//!   - 关掉弹窗不影响正在跑的转录；
//!   - 用户切到别的标签页，回来时进度还在。

import { coalesce, partitionByBoundaries } from '../core/paragraphs.js';
import { planChunks, mapPool } from '../core/chunk.js';
import { buildMessages, parsePolishResponse, applyPolish, resetPolish, instructionFor } from '../core/prompt.js';
import { buildDoc } from '../core/format.js';
import { fmtTs } from '../core/time.js';
import { normalizeChapters } from '../core/subtitles.js';
import { LOCAL_POLISH } from '../core/settings.js';
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
async function llmChat(payload, onDelta, signal) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'llm.stream' });
    const abort = () => { port.disconnect(); reject(new AbortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    port.onDisconnect.addListener(() => reject(new Error('润色连接中断')));
    port.onMessage.addListener((message) => {
      if (message.delta) onDelta(message.delta);
      if (!message.done) return;
      signal?.removeEventListener('abort', abort);
      port.disconnect();
      message.ok ? resolve(message) : reject(new Error(message.error ?? '润色失败'));
    });
    port.postMessage(payload);
  });
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

  const remaining = [...tracks];
  let track;
  let events = [];
  let lastError = '';
  while ((track = pickTrack(remaining, {
    preferLang: settings.subtitle.preferLang,
    allowAuto: settings.subtitle.allowAuto,
    pageLang: meta.language,
  }))) {
    onProgress?.('download', { message: `正在取字幕：${trackLabel(track)}` });
    try { events = await readTrack(track); } catch (error) { lastError = String(error?.message ?? error); }
    if (events.length) break;
    remaining.splice(remaining.indexOf(track), 1);
  }
  if (!events.length) {
    throw new MissingSourceError(
      `${lastError ? `字幕地址不可用：${lastError}。` : '平台没有返回可用字幕。'}可改用本地模型转录。`,
    );
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
export async function runAsrPipeline({ adapter, meta, settings, onProgress, onPartial, signal }) {
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

  if (/^https?:\/\/(?:127\.0\.0\.1|localhost):8081\/v1\/audio\/transcriptions\/?$/.test(asr.endpoint)) {
    onProgress?.('capture', { ratio: 0, message: '正在启动本机转录服务' });
    const started = await chrome.runtime.sendMessage({ type: 'asr.local.start' });
    if (!started?.ok) throw new Error(started?.error ?? '本机转录服务启动失败');
    if (started.value?.state === 'error') throw new Error(started.value.message);
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
      let seen = 0;
      do {
        if (signal?.aborted) throw new AbortError();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const reply = await chrome.runtime.sendMessage({ type: 'asr.fast.status', payload: { id: started.value.id, after: seen } });
        if (!reply?.ok) throw new Error(reply?.error ?? '本机任务查询失败');
        job = reply.value;
        if (job.events?.length) {
          await simplifyBilibili(job.events, adapter.id);
          events.push(...job.events);
          seen += job.events.length;
          onPartial?.(events);
        }
        onProgress?.('capture', { ratio: job.total ? job.done / job.total : 0, message: job.message });
      } while (job.state === 'running');
      if (job.state === 'error') throw new Error(job.error);
      if (events.length) {
        await simplifyBilibili(events, adapter.id);
        const built = organize(events, meta, {});
        return {
          ...built,
          stats: {
            source: 'asr',
            trackLabel: `${asr.model || '本机模型'} · 本机快速提取`,
            eventCount: events.length,
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
      if (events.length) {
        events.length = 0;
        onPartial?.(events);
      }
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
      }).then(async (reply) => {
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
        await simplifyBilibili(events, adapter.id);
        onPartial?.(events);
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

  await simplifyBilibili(events, adapter.id);
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

let biliConverter;
async function simplifyBilibili(events, site) {
  if (site !== 'bilibili') return;
  biliConverter ??= import('../vendor/opencc-t2cn.js').then(({ Converter }) => Converter({ from: 't', to: 'cn' }));
  const convert = await biliConverter;
  for (const event of events) event.text = convert(event.text);
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
      seg.text = punctuate(seg.text);
      if (seg.raw) seg.raw = punctuate(seg.raw);
      segments.push(seg);
      seg.id = segments.length - 1;
      sectionIndexOf.push(i);
    }
  });

  return { sections, segments, sectionIndexOf, chapters };
}

/**
 * 事件列表 -> 章节下标（与 partitionByBoundaries 的中点归属一致）。
 * 转录进行中就能算，用于在组织成段落之前先润色事件。
 */
export function eventSectionIndexOf(events, meta) {
  const marks = [...new Set((meta?.chapters ?? [])
    .map((c) => Number(c?.t))
    .filter((n) => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
  if (!marks.length) return events.map(() => 0);
  return events.map((e) => {
    const mid = (Number(e.start) + Number(e.end)) / 2;
    let idx = 0;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i] <= mid) idx = i;
      else break;
    }
    return idx;
  });
}

function punctuate(text) {
  const value = String(text ?? '').trim();
  if (!value || /[。！？.!?；;][”’"')）】]*$/u.test(value)) return value;
  const mark = /[A-Za-z0-9]$/u.test(value) ? '.' : '。';
  return value.replace(/[，,、：:]$/u, '') + mark;
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
 * @param {{ensure:()=>Promise<object>}} [args.fallback] 自备 LLM 三次失败后的本地回落；ensure 返回本机模型的 LLM 配置
 * @param {boolean} [args.resume] 续润：跳过已润色的段落，只处理剩下的
 * @returns {Promise<{chunks:number, polished:number, failed:number, removed:number, errors:string[], firstError:string}>}
 */
export async function polishSegments({ segments, sectionIndexOf, meta, settings, onProgress, onSegment, onReset, signal, fallback, resume = false }) {
  if (resume) onReset?.();
  else {
    resetPolish(segments);
    onReset?.();
  }

  const llm = settings.llm;
  const chunks = planChunks(segments, {
    contextChars: llm.contextChars,
    sectionOf: (i) => sectionIndexOf?.[i] ?? 0,
    onlyUnpolished: resume,
  });
  if (!chunks.length) {
    return { chunks: 0, polished: 0, failed: 0, removed: 0, errors: [] };
  }
  onProgress?.(0, chunks.length);

  const errors = [];
  let firstError = '';
  let polished = 0;
  let removed = 0;

  /** 把一块流式覆盖过的段落还原回原文。 */
  const revertSeen = (seen) => {
    for (const id of seen) {
      const seg = segments[id];
      if (seg.raw) seg.text = seg.raw;
      delete seg.raw;
      seg.state = 'kept';
      onSegment?.(id);
    }
  };

  /** 一块的完整一次尝试：流式覆盖 -> 校验 -> 应用。失败时还原流式痕迹。 */
  const attemptChunk = async (chunk, llmConfig) => {
    if (signal?.aborted) throw new AbortError();
    const messages = buildMessages({
      segments,
      chunk,
      meta,
      instruction: instructionFor(settings.polishLevel, llmConfig.instruction),
      glossary: llmConfig.glossary,
      langHint: meta.language,
    });
    let streamed = '';
    let consumed = 0;
    const seen = new Set();
    let reply;
    try { reply = await llmChat({
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model,
      messages,
    }, (delta) => {
      streamed += delta;
      let lastEnd = 0;
      for (const match of streamed.slice(consumed).matchAll(/\{"id":\s*(\d+),\s*"text":\s*"(?:\\.|[^"\\])*"\}/g)) {
        lastEnd = match.index + match[0].length;
        let item;
        try { item = JSON.parse(match[0]); } catch { continue; }
        if (seen.has(item.id) || !chunk.ids.includes(item.id)) continue;
        seen.add(item.id);
        if (item.text.trim()) {
          const seg = segments[item.id];
          seg.raw ??= seg.text;
          seg.text = item.text.trim();
          seg.state = 'polished';
          onSegment?.(item.id);
        }
      }
      consumed += lastEnd;
    }, signal); } catch (error) {
      revertSeen(seen);
      throw error;
    }
    const parsed = parsePolishResponse(reply.content);
    const outcome = applyPolish(segments, chunk.ids, parsed);
    if (!outcome.applied) {
      revertSeen(seen);
      throw new Error(
        parsed
          ? '模型返回的条目与请求对不上，这一块保留原文'
          : '模型没有返回可解析的 JSON，这一块保留原文',
      );
    }
    return outcome;
  };

  // 本地回落：懒启动一次，之后串行执行，不与自备 LLM 的并发叠加。
  const usingLocal = String(llm.baseUrl ?? '').replace(/\/+$/, '') === LOCAL_POLISH.baseUrl;
  let fallbackReady = null;
  let fallbackEnsureError = null;
  let fallbackQueue = Promise.resolve();
  const ensureFallback = () => {
    if (!fallbackReady) {
      fallbackReady = Promise.resolve()
        .then(() => fallback.ensure())
        .catch((error) => {
          fallbackEnsureError = error;
          return null;
        });
    }
    return fallbackReady;
  };

  const results = await mapPool(
    chunks,
    llm.concurrency,
    async (chunk) => {
      // 一块最多尝试三次；都用自备 LLM 失败后，静默换成本机润色
      let lastError = new Error('模型未返回可用文本');
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { return await attemptChunk(chunk, llm); } catch (error) {
          if (signal?.aborted) throw error;
          lastError = error;
        }
      }
      if (!usingLocal && fallback) {
        const fallbackLlm = await ensureFallback();
        if (fallbackLlm) {
          const task = fallbackQueue.then(() => attemptChunk(chunk, fallbackLlm));
          fallbackQueue = task.catch(() => {});
          return task;
        }
        if (fallbackEnsureError) throw new Error(`本机润色未启动：${String(fallbackEnsureError?.message ?? fallbackEnsureError)}`);
      }
      throw lastError;
    },
    (done, total, outcome) => {
      if (outcome?.error && !firstError) firstError = String(outcome.error?.message ?? outcome.error);
      onProgress?.(done, total);
    },
  );

  results.forEach((outcome, i) => {
    if (!outcome) {
      if (!signal?.aborted) errors.push(`第 ${i + 1}/${chunks.length} 块未润色`);
      return;
    }
    polished += outcome.applied ? 1 : 0;
    removed += outcome.removed;
  });

  return { chunks: chunks.length, polished, failed: errors.length, removed, errors, firstError };
}

/** 由 pipeline 结果生成最终文档。 */
export function finalize(built, meta, settings) {
  // stats 由两个 pipeline 各自填；这里兜一层，避免调用方少传一个字段就崩
  const source = built?.stats?.source ?? settings?.source ?? 'subtitle';
  const doc = buildDoc({ ...meta, source }, built?.sections ?? []);
  doc.meta.showTimestamps = settings.showTimestamps;
  doc.meta.imageLevel = settings.imageLevel;
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
