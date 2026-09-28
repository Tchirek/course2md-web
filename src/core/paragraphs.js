//! 段落组织：把细粒度字幕/ASR 片段合并成可阅读的段落。
// 常量与算法取自 course2md 的 timeline.rs::coalesce_sections，
// 保持同样的断段阈值，两边产出的段落边界才会一致。

import { normalizeEvent } from './model.js';

/** 同一节内相邻片段间隔超过此值则分段。 */
export const PARAGRAPH_GAP_SECS = 3.5;
/** 单段最大字符数（超过则强制分段）。 */
export const MAX_PARAGRAPH_CHARS = 420;

/** 独立成条的纯语气词（剥掉标点后整条只剩这些字）。 */
const FILLERS = new Set(['嗯', '呃', '额', '啊', '哦', '唔', '唉', '诶', '噢']);

/**
 * 需要从两端剥掉、用于判断「是否只剩语气词」的标点与空白。
 * 用 Set 而不是拼一个正则字符类：`[`/`]`/`-` 放进字符类里会被当成元字符，
 * 手写容易写出「字符类提前闭合」这种静默失效。
 */
const TRIM_CHARS = new Set([
  ...'，。！？、,.!?：:；;',
  ...'“”‘’\'"',
  ...'（）()【】[]《》〈〉',
  ...'…—–-～~',
  ' ',
]);

/** 整条是否只是语气词 / 无实义片段。 */
export function isStandaloneFiller(text) {
  const chars = [...String(text)];
  let start = 0;
  let end = chars.length;
  while (start < end && (/\s/.test(chars[start]) || TRIM_CHARS.has(chars[start]))) start++;
  while (end > start && (/\s/.test(chars[end - 1]) || TRIM_CHARS.has(chars[end - 1]))) end--;
  return FILLERS.has(chars.slice(start, end).join(''));
}

const LATIN_WORD = /[0-9A-Za-z\u00c0-\u024f\u1e00-\u1eff]/;

/**
 * 拼接两段文本：保留拉丁文字的词间空格；中文、日文直接相连。
 * @param {string} prev
 * @param {string} next
 */
export function appendText(prev, next) {
  const tail = prev.replace(/[.,!?:;)\]}»”"’]+$/, '');
  const lastChar = [...tail].pop() ?? '';
  const nextChar = [...next][0] ?? '';
  const needsSpace = LATIN_WORD.test(lastChar) && LATIN_WORD.test(nextChar);
  return prev + (needsSpace ? ' ' : '') + next;
}

/**
 * 合并 ASR 常见的重复（Whisper 在长静音处偶发循环）。
 *
 * 两道处理，都只在高置信时才动手：
 *  1. 空白分词的连续重复 token（拉丁文字）——允许一次重复，第三次起丢弃。
 *  2. 整条文本是一个短句的整数次重复（中文没有空格，靠周期检测）——
 *     只有**整条**都重复时才折叠一次。正常散文永远不会满足这个条件，
 *     所以这里不会改坏正文。
 * @param {string} text
 */
export function dedupeRepeats(text) {
  const collapsed = collapseWholeStringLoop(String(text));
  // 允许一次重复（口语本就重复），第三次起折叠掉，连同它前面的空白
  return collapsed.replace(/(\S+)(\s+\1){1,}/gu, '$1$2');
}

/** 整条是否为一个短模式的重复；是则只留一份。 */
function collapseWholeStringLoop(text) {
  const chars = [...String(text).trim()];
  const n = chars.length;
  if (n < 12) return text;

  const isPeriod = (p) => {
    if (n % p !== 0) return false;
    for (let i = p; i < n; i++) if (chars[i] !== chars[i % p]) return false;
    return true;
  };

  const maxP = Math.min(40, Math.floor(n / 3));
  for (let p = 1; p <= maxP; p++) {
    if (isPeriod(p)) return chars.slice(0, p).join('').trim();
  }
  return text;
}

/**
 * 把一段连续事件组织为段落。
 *
 * 输入应为「同一时间窗内」的事件（视频整体，或按幻灯片切分后的某一节）。
 * 独立的无语义填充词不单独成段；嵌在有效语句中的文本不会被删除。
 *
 * @param {import('./model.js').TranscriptEvent[]} events
 * @param {object} [opts]
 * @param {number} [opts.gapSecs]
 * @param {number} [opts.maxChars]
 * @param {boolean} [opts.dropFillers] 是否丢弃独立语气词（默认 true）
 * @returns {import('./model.js').Segment[]}
 */
export function coalesce(events, opts = {}) {
  const gapSecs = opts.gapSecs ?? PARAGRAPH_GAP_SECS;
  const maxChars = opts.maxChars ?? MAX_PARAGRAPH_CHARS;
  const dropFillers = opts.dropFillers !== false;

  const segments = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    // raw 与 text 相同（未润色过）时不重复存，省一半体积
    if (cur.raw === cur.text) delete cur.raw;
    segments.push(cur);
    cur = null;
  };

  for (const rawEvent of events) {
    const event = normalizeEvent(rawEvent);
    if (!event) continue;

    // text 是展示文本；raw 是原文（润色后仍保留），未润色时两者相同
    const display = event.text.trim();
    if (display === '') continue;
    const original = (event.raw ?? event.text).trim();
    if (dropFillers && isStandaloneFiller(original)) continue;

    const shouldBreak =
      cur !== null &&
      (event.start - cur.end > gapSecs ||
        [...cur.text].length + [...display].length > maxChars);

    if (shouldBreak) flush();

    if (cur) {
      cur.text = appendText(cur.text, display);
      // 只在 raw 已经存在时继续累积；否则会从空串拼出半截原文
      if (cur.raw !== undefined) cur.raw = appendText(cur.raw, original);
      cur.end = Math.max(cur.end, event.end);
    } else {
      cur = {
        start: event.start,
        end: event.end,
        text: display,
        raw: original,
        state: 'kept',
      };
    }
  }
  flush();
  return segments;
}

/**
 * 按幻灯片/时间标记切分事件，再各自组织段落。
 * 对应 course2md 的 Section：每张截图覆盖一段语音。
 *
 * @param {import('./model.js').TranscriptEvent[]} events
 * @param {number[]} boundaries 升序的时间边界（幻灯片/章节时刻）
 * @param {object} [opts] 传给 coalesce；另支持 opts.mediaEnd 作为末段终点
 * @returns {{t:number, end:number, segments:import('./model.js').Segment[]}[]}
 */
export function partitionByBoundaries(events, boundaries, opts = {}) {
  const marks = [...new Set(boundaries.filter((n) => Number.isFinite(n) && n >= 0))]
    .sort((a, b) => a - b);
  if (!marks.length) return [];

  const buckets = marks.map((t, i) => ({
    t,
    end: i + 1 < marks.length ? marks[i + 1] : Infinity,
    segments: [],
  }));

  const accepted = [];
  for (const e of events) {
    const ev = normalizeEvent(e);
    if (ev) accepted.push(ev);
  }

  for (const ev of accepted) {
    const mid = (ev.start + ev.end) / 2;
    // 每条语音归属于「时间 <= 中点的最后一个边界」；首个边界之前归第一个
    let idx = 0;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i] <= mid) idx = i;
      else break;
    }
    buckets[idx].segments.push(ev);
  }

  const lastEnd = Number.isFinite(opts.mediaEnd)
    ? opts.mediaEnd
    : Math.max(0, ...accepted.map((e) => e.end));

  return buckets.map((b, i) => ({
    t: b.t,
    end: i === buckets.length - 1 ? Math.max(b.t, lastEnd) : b.end,
    segments: coalesce(b.segments, opts),
  }));
}
