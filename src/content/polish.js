//! 整形（润色）：段落を塊に分けて LLM に並行で送り、段落 ID を厳密に対応づけて書き戻す。

import { planChunks, mapPool } from '../core/chunk.js';
import { buildMessages, parsePolishResponse, applyPolish, resetPolish, instructionFor } from '../core/prompt.js';
import { LOCAL_POLISH } from '../core/settings.js';
import { AbortError } from '../core/errors.js';

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
 * 润色。分块并行，块内 id 严格对应（详见 core/chunk.js 与 core/prompt.js 的说明）。
 *
 * @param {object} args
 * @param {object[]} args.segments 平坦段落（会被就地修改）
 * @param {number[]} args.sectionIndexOf
 * @param {object} args.meta
 * @param {object} args.settings
 * @param {(done:number,total:number)=>void} [args.onProgress]
 * @param {(id:number)=>void} [args.onSegment] 段落の整形結果を書き戻したらすぐ知らせる（浮窓を段落ごとに更新）
 * @param {()=>void} [args.onReset] 整形の状態を初期化したとき、または続きから整形を始めるときに知らせる
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
    return { chunks: 0, polished: 0, failed: 0, removed: 0, errors: [], firstError: '' };
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
          fallbackQueue = task.then(() => {}, () => {});
          return task;
        }
        if (fallbackEnsureError) throw new Error(`本机润色未启动：${String(fallbackEnsureError?.message ?? fallbackEnsureError)}`);
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
