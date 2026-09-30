//! 数据模型：转写事件、段落、文档。
// 字段名与 course2md 的 TranscriptEvent / Section 对齐，
// 便于两边交换 JSON，也便于用户直接看懂导出的结构化数据。

/** 结构化输出的 schema 版本；任何破坏性变更必须递增。 */
export const SCHEMA_VERSION = 1;

/** 文字来源。 */
export const SOURCE = {
  /** 平台字幕（YouTube timedtext / B 站 subtitle_url / <track>）。 */
  SUBTITLE: 'subtitle',
  /** 本地模型转录（音频在本机转写，不经过任何云服务）。 */
  ASR: 'asr',
};

/**
 * 一条转写事件。
 * @typedef {object} TranscriptEvent
 * @property {number} start 开始秒
 * @property {number} end   结束秒
 * @property {string} text  展示文本（润色后）；未润色时与 raw 相同
 * @property {string} [raw] ASR/字幕原文（provenance）；润色后保留
 * @property {'polished'|'kept'|'skipped'} [state] 整形の状態（整形結果を書き戻した後にだけある）
 */

/**
 * 一个段落（由同一节内相邻事件合并而成）。
 * @typedef {object} Segment
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {string} [raw]
 * @property {'polished'|'kept'|'skipped'} [state] 润色状态
 * @property {number} [id] 全体の平坦な段落一覧での添字（整形はこれで対応づける）
 */

/**
 * 校验并规范化一条转写事件。缺字段、时间倒置、空文本都会被修正或拒绝。
 * @param {any} e 任意の入力（字幕、ASR、キャッシュから）
 * @returns {TranscriptEvent|null}
 */
export function normalizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const start = Number(e.start);
  const end = Number(e.end);
  const text = typeof e.text === 'string' ? e.text : '';
  if (!Number.isFinite(start)) return null;
  const safeEnd = Number.isFinite(end) && end >= start ? end : start;
  /** @type {TranscriptEvent} */
  const out = { start: Math.max(0, start), end: Math.max(0, safeEnd), text };
  if (typeof e.raw === 'string' && e.raw.length > 0) out.raw = e.raw;
  if (typeof e.state === 'string' && e.state) out.state = e.state;
  return out;
}

/**
 * 按 start 升序排列；同 start 保持原相对顺序（稳定）。
 * @param {TranscriptEvent[]} events
 */
export function sortEvents(events) {
  return events
    .map((e, i) => /** @type {[TranscriptEvent, number]} */ ([e, i]))
    .sort((a, b) => a[0].start - b[0].start || a[1] - b[1])
    .map(([e]) => e);
}

/**
 * 事件列表覆盖的时长（末条 end - 首条 start），用于进度与估算。
 * @param {TranscriptEvent[]} events
 */
export function spanSeconds(events) {
  if (!events.length) return 0;
  const first = events[0].start;
  const last = Math.max(...events.map((e) => e.end));
  return Math.max(0, last - first);
}

/**
 * 事件总字符数。
 * @param {TranscriptEvent[]} events
 */
export function totalChars(events) {
  return events.reduce((n, e) => n + [...e.text].length, 0);
}
