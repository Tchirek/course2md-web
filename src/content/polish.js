//! 整形（润色）：段落を塊に分けて LLM に並行で送り、段落 ID を厳密に対応づけて書き戻す。

import { planChunks, mapPool } from '../core/chunk.js';
import { buildMessages, parsePolishResponse, applyPolish, resetPolish, instructionFor } from '../core/prompt.js';
import { LOCAL_POLISH } from '../core/settings.js';
import { AbortError } from '../core/errors.js';

/** @typedef {{baseUrl: string, apiKey: string, model: string, instruction?: string, glossary?: string}} LlmConfig 一次润色请求要用的模型配置 */

/**
 * 通过后台发一次 LLM 对话请求。
 * @param {{baseUrl: string, apiKey: string, model: string, messages: {role: string, content: string}[]}} payload
 * @param {(delta: string) => void} onDelta 流式到达的片段
 * @param {AbortSignal} [signal]
 * @returns {Promise<{content: string}>} 后台发来的最后一条消息
 */
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
 * 润色。分块并行，块内 id 严格对应（详见 core/chunk.js 与 core/prompt.js 的说明）。
 *
 * @param {object} args
 * @param {import('../core/model.js').Segment[]} args.segments 平坦段落（会被就地修改）
 * @param {number[]} [args.sectionIndexOf] 段落下标 -> 章节下标（没有就都算第 0 节）
 * @param {{title?: string, uploader?: string, language?: string, url?: string, duration?: number}} args.meta
 * @param {import('../core/settings.js').Settings} args.settings
 * @param {(done:number,total:number)=>void} [args.onProgress]
 * @param {(id:number)=>void} [args.onSegment] 段落の整形結果を書き戻したらすぐ知らせる（浮窓を段落ごとに更新）
 * @param {()=>void} [args.onReset] 整形の状態を初期化したとき、または続きから整形を始めるときに知らせる
 * @param {AbortSignal} [args.signal]
 * @param {{ensure:()=>Promise<LlmConfig>}} [args.fallback] 自备 LLM 三次失败后的本地回落；ensure 返回本机模型的 LLM 配置
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
    return { chunks: 0, polished: 0, failed: 0, removed: 0, errors: [], firstError: '' };
  }
  onProgress?.(0, chunks.length);

  /** @type {string[]} */
  const errors = [];
  let firstError = '';
  let polished = 0;
  let removed = 0;

  /** 把一块流式覆盖过的段落还原回原文。 */
  const revertSeen = (/** @type {Set<number>} */ seen) => {
    for (const id of seen) {
      const seg = segments[id];
      if (seg.raw) seg.text = seg.raw;
      delete seg.raw;
      seg.state = 'kept';
      onSegment?.(id);
    }
  };

  /**
   * 一块的完整一次尝试：流式覆盖 -> 校验 -> 应用。失败时还原流式痕迹。
   * @param {import('../core/chunk.js').Chunk} chunk
   * @param {LlmConfig} llmConfig
   */
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
    /** @type {Set<number>} */
    const seen = new Set();
    let reply;
    const usingCli = llmConfig.baseUrl === LOCAL_POLISH.baseUrl;
    try { reply = usingCli ? await cliPolish({
      sourceUrl: meta.url, title: meta.title, duration: meta.duration,
      // The CLI assigns its own batch IDs; retain hints without the Web ID contract.
      instruction: [instructionFor(settings.polishLevel, llmConfig.instruction), messages[1].content.slice(0, messages[1].content.lastIndexOf('待校对：\n'))].join('\n\n'),
      segments: chunk.ids.map((id) => ({ id, start: segments[id].start, end: segments[id].end, text: segments[id].raw ?? segments[id].text })),
    }, signal) : await llmChat({
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
        if (item.text.trim() && !/^\s*\{\s*"segments"\s*:/.test(item.text)) {
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
    if (usingCli) for (const id of chunk.ids) onSegment?.(id);
    return outcome;
  };

  // 本地回落：懒启动一次，之后串行执行，不与自备 LLM 的并发叠加。
  const usingLocal = String(llm.baseUrl ?? '').replace(/\/+$/, '') === LOCAL_POLISH.baseUrl;
  /** @type {Promise<LlmConfig|null>|null} */
  let fallbackReady = null;
  /** @type {unknown} */
  let fallbackEnsureError = null;
  let fallbackQueue = Promise.resolve();
  /** @param {{ensure:()=>Promise<LlmConfig>}} source */
  const ensureFallback = (source) => {
    if (!fallbackReady) {
      fallbackReady = Promise.resolve()
        .then(() => source.ensure())
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
      /** @type {unknown} */
      let lastError = new Error('模型未返回可用文本');
      // The CLI owns its own retry/receipt policy; do not multiply its paid requests.
      for (let attempt = 1; attempt <= (usingLocal ? 1 : 3); attempt++) {
        try { return await attemptChunk(chunk, llm); } catch (error) {
          if (signal?.aborted) throw error;
          lastError = error;
        }
      }
      if (!usingLocal && fallback) {
        const fallbackLlm = await ensureFallback(fallback);
        if (fallbackLlm) {
          const task = fallbackQueue.then(() => attemptChunk(chunk, fallbackLlm));
          fallbackQueue = task.then(() => {}, () => {});
          return task;
        }
        if (fallbackEnsureError) throw new Error(`CLI 润色配置不可用：${String(/** @type {{message?: string}} */ (fallbackEnsureError)?.message ?? fallbackEnsureError)}`);
      }
      throw lastError;
    },
    (done, total, outcome) => {
      if (outcome && 'error' in outcome && !firstError) {
        const error = /** @type {any} */ (outcome.error);
        firstError = String(error?.message ?? error);
      }
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

/**
 * CLI results arrive by chunk; browser API results still stream by paragraph.
 * @param {object} payload
 * @param {AbortSignal} [signal]
 */
async function cliPolish(payload, signal) {
  if (signal?.aborted) throw new AbortError();
  const started = await chrome.runtime.sendMessage({ type: 'cli.polish.start', payload });
  if (!started?.ok || !started.value?.id) throw new Error(started?.error || 'CLI 润色未启动');
  const id = started.value.id;
  try {
    while (!signal?.aborted) {
      const reply = await chrome.runtime.sendMessage({ type: 'cli.polish.status', payload: { id } });
      if (!reply?.ok) throw new Error(reply?.error || 'CLI 润色查询失败');
      if (reply.value.state === 'done') return { content: JSON.stringify({ segments: reply.value.segments }) };
      if (reply.value.state === 'error') throw new Error(reply.value.error);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new AbortError();
  } finally {
    if (signal?.aborted) chrome.runtime.sendMessage({ type: 'cli.polish.cancel', payload: { id } }).catch(() => {});
  }
}
