//! LLM 润色的分块规划。
//!
//! 为什么不是「每句一请求」，也不是「整篇一请求」：
//!
//! - 逐句请求：模型看不到上下文，无法修断句、无法把被字幕切碎的两半合回去，
//!   还会把整段口语压成一个孤立短句。N 句 = N 次请求，成本与延迟都不可接受。
//! - 整篇请求：长视频有几万字，超出上下文；中途失败等于全部白做；输出越长越
//!   容易漂移（漏条目、改原意、开始总结）。
//! - 本模块走中间路线：按「段落边界」切块，块内是连续的完整段落，块与块之间
//!   并行、互不影响。这取自 course2md 的 BATCH = 20 设计，并做了两点补强：
//!     1. 块首附上一块的**尾部只读上下文**，让跨块边界处的断句/指代仍然连贯；
//!     2. 按字符预算切而非只按条数切，中英混排时长段不会撑爆单个请求。
//!
//! 切块只落在段落边界上，任何一块都不会把一句话劈成两半。

/** 单块最多段落数（对应 course2md 的 BATCH）。 */
export const CHUNK_MAX_ITEMS = 20;
/** 单块最多字符数（中英混排的软上限；按段落整体收放，不切断段落）。 */
export const CHUNK_MAX_CHARS = 1200;
/** 带进下一块作为只读上下文的前文尾长。 */
export const CHUNK_CONTEXT_CHARS = 160;

/**
 * @typedef {object} Chunk
 * @property {number[]} ids       该块要改写的段落全局下标（升序，连续）
 * @property {string} context     上一块尾部原文，只读参考；首块为 ''
 */

/**
 * 把段落列表切成请求块。
 *
 * @param {import('./model.js').Segment[]} segments
 * @param {object} [opts]
 * @param {number} [opts.maxItems]
 * @param {number} [opts.maxChars]
 * @param {number} [opts.contextChars]
 * @param {boolean} [opts.onlyUnpolished] 続きから整形：整形済みの段落を飛ばす
 * @param {(i:number)=>number} [opts.sectionOf] 段落下标 -> 章节下标；
 *        同一块不跨章节（章节内语言/话题一致，块内上下文更干净）
 * @returns {Chunk[]}
 */
export function planChunks(segments, opts = {}) {
  const maxItems = opts.maxItems ?? CHUNK_MAX_ITEMS;
  const maxChars = opts.maxChars ?? CHUNK_MAX_CHARS;
  const contextChars = opts.contextChars ?? CHUNK_CONTEXT_CHARS;
  const sectionOf = opts.sectionOf ?? (() => 0);
  /** 续润模式：state 已是 polished 的段落跳过，只规划剩下的。 */
  const onlyUnpolished = opts.onlyUnpolished === true;

  /** @type {Chunk[]} */
  const chunks = [];
  /** @type {number[]} */
  let ids = [];
  let chars = 0;
  /** @type {unknown} */
  let section = null;
  /** 下一块可用的只读上下文；换章节时清空。 */
  let nextContext = '';

  const flush = () => {
    if (!ids.length) return;
    const lastId = ids[ids.length - 1];
    chunks.push({ ids, context: nextContext });
    nextContext = tailOf(segments[lastId].text, contextChars);
    ids = [];
    chars = 0;
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const sec = sectionOf(i);

    if (onlyUnpolished && seg.state === 'polished') {
      // 已润色的段落不再送进块里，只当后续块的上下文
      if (ids.length) flush();
      nextContext = sec === section ? tailOf(seg.text, contextChars) : '';
      section = sec;
      continue;
    }

    const len = [...seg.text].length;

    if (ids.length > 0) {
      if (sec !== section) {
        flush();
        // 跨章节时上一节的尾句是干扰，不作为上下文
        nextContext = '';
      } else if (ids.length >= maxItems || chars + len > maxChars) {
        flush();
      }
    }

    section = sec;
    ids.push(i);
    chars += len;
  }
  flush();

  return chunks;
}

/**
 * 取字符串尾部 n 个字符（按码点计，不会切坏 emoji/汉字）。
 * @param {unknown} text
 * @param {number} n
 */
export function tailOf(text, n) {
  const chars = [...String(text)];
  if (chars.length <= n) return chars.join('');
  return chars.slice(chars.length - n).join('');
}

/**
 * 并发跑一批任务，保持输入顺序与结果顺序一致。
 *
 * course2md 默认并发 8（上限 16）。浏览器里每个请求都是跨域 fetch，
 * 并发过高会撞上服务端的速率限制，也会让用户本机的 Ollama 排队，
 * 因此默认降到 4；用户可在设置里调高。
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @param {(done:number, total:number, result:R|{error:unknown, index:number})=>void} [onProgress]
 *   worker が例外を投げたとき、第 3 引数は {error, index}
 * @returns {Promise<(R|null)[]>} 与 items 等长、顺序一致；worker 抛错时该位置为 null
 */
export async function mapPool(items, limit, worker, onProgress) {
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  const results = new Array(items.length).fill(null);
  let next = 0;
  let done = 0;

  const run = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = null;
        if (onProgress) onProgress(++done, items.length, { error: err, index: i });
        continue;
      }
      if (onProgress) onProgress(++done, items.length, results[i]);
    }
  };

  await Promise.all(Array.from({ length: size }, run));
  return results;
}
