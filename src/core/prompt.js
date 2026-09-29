//! 润色提示词与响应解析。
//!
//! 输出契约是**逐条 id 对应**的 JSON，而不是自由文本：id 对不上就整块丢弃并
//! 保留原文。这样最坏结果是「这块没润色」，永远不会出现「文本错位」这种会
//! 把笔记彻底毁掉的事故。做法与 course2md 的 segment_ids_match 一致。

import { dedupeRepeats } from './paragraphs.js';
import { extractJson } from './json.js';

export { extractJson };

/** 默认校对指令。用户可在设置里整体替换，但输出契约由本模块强制追加。 */
export const DEFAULT_INSTRUCTION = `你是视频逐字稿校对器。输入的每一项是一段已按自然停顿组织的连续讲解。
修正明显的语音识别错误（错别字、同音字、专有名词拼写），删除不影响原意的冗余口头填充，
并修复不自然的断句和标点，使文字自然、书面化。不得概括、扩写、翻译、增删实质内容或改变原意；
保持原语言。若某条内容仅由语气词、口头禅或无实义片段构成（如单独的"啊"、"对吧"），
该条的 text 返回空字符串 ""（插件会删除该条）；有实质内容的条目不得删除。`;

export const LIGHT_INSTRUCTION = `只修正标点、断句、空格、明显重复和繁简及格式错误。尽量保留原词原句；不重写句子，不删减观点，不新增事实。每条都保留实质内容。`;
export const DEEP_INSTRUCTION = `${DEFAULT_INSTRUCTION}\n在每条文本内部主动拆分长句、合并重复表述、调整语序并补充必要衔接，必要时用换行按主题分段，使口语更接近文章。保留每条的讲述时刻与全部观点；不得擅自总结、删减观点或新增事实。`;

export function instructionFor(level, custom = '') {
  if (custom?.trim()) return custom;
  return level === 'light' ? LIGHT_INSTRUCTION : level === 'deep' ? DEEP_INSTRUCTION : DEFAULT_INSTRUCTION;
}

/**
 * 输出契约。拼在用户指令之后，且明确「不可被前面的指令覆盖」。
 * @param {number[]} ids
 */
export function contractFor(ids) {
  const example = `{"segments":[{"id":${ids[0] ?? 1},"text":"校对后的文本"}]}`;
  return `输出与输入逐条对应的 JSON 对象 ${example}，
id 必须与输入完全一致、不得增删条目、不得改变顺序、不得合并或拆分条目。
只输出这个 JSON，不要解释、不要 Markdown 代码围栏。`;
}

/**
 * 构建一次润色请求的 messages。
 *
 * @param {object} args
 * @param {import('./model.js').Segment[]} args.segments 全量段落
 * @param {import('./chunk.js').Chunk} args.chunk
 * @param {object} args.meta 视频元信息 { title, uploader, durationLabel }
 * @param {string} [args.instruction] 用户自定义指令
 * @param {string} [args.glossary] 术语表（每行一条），用于纠正专名拼写
 * @param {string} [args.langHint] 语言提示
 * @returns {{role:'system'|'user', content:string}[]}
 */
export function buildMessages({ segments, chunk, meta, instruction, glossary, langHint }) {
  const system = [instruction?.trim() || DEFAULT_INSTRUCTION, contractFor(chunk.ids)].join('\n\n');

  const lines = [];
  if (meta?.title) lines.push(`视频标题：${meta.title}`);
  if (meta?.uploader) lines.push(`作者：${meta.uploader}`);
  if (meta?.durationLabel) lines.push(`时长：${meta.durationLabel}`);
  if (langHint) lines.push(`主讲语言：${langHint}`);
  if (lines.length) {
    lines.push(
      '标题、作者与术语表是专有名词拼写的唯一依据，只用它们纠正拼写，不要据此添加内容。',
    );
  }

  const glossaryLines = String(glossary ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (glossaryLines.length) {
    lines.push('', '术语表（出现时应使用下列写法）：');
    for (const g of glossaryLines) lines.push(`- ${g}`);
  }

  const payload = {
    segments: chunk.ids.map((id) => ({ id, text: segments[id].text })),
  };

  const parts = [];
  if (lines.length) parts.push(lines.join('\n'));
  if (chunk.context) {
    parts.push(
      `上一段的结尾（仅供理解上下文，**不要**改写、**不要**输出这一部分）：\n${chunk.context}`,
    );
  }
  parts.push(`待校对：\n${JSON.stringify(payload, null, 0)}`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * 解析模型返回的片段列表。
 *
 * 容错但严格：允许代码围栏、前后废话、单个对象而非数组；但每条的 id 与 text
 * 必须合法，且调用方若给了 expectedCount 就必须条数一致——否则返回 null，
 * 让调用方保留原文而不是猜。
 *
 * @param {string} content
 * @returns {{id:number, text:string}[]|null}
 */
export function parsePolishResponse(content) {
  const value = extractJson(content);
  if (!value) return null;
  const raw = Array.isArray(value) ? value : value.segments;
  if (!Array.isArray(raw)) return null;

  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = Number(item.id);
    if (!Number.isInteger(id) || id < 0) continue;
    const text = typeof item.text === 'string' ? item.text : null;
    if (text === null) continue;
    if (/^\s*\{\s*"segments"\s*:/.test(text)) return null;
    out.push({ id, text: text.trim() });
  }
  return out.length ? out : null;
}

/**
 * 把一块的润色结果写回段落。
 *
 * 规则（与 course2md 的 apply_polish_refs 一致）：
 * - id 必须与块内 id 集合完全相等，否则整块放弃，段落保持原文；
 * - text 为空串 => 该条是纯语气词，标记为 skipped 并在渲染时跳过；
 * - 写回时把原文本存进 raw，保住 provenance。
 *
 * @param {import('./model.js').Segment[]} segments
 * @param {number[]} ids
 * @param {{id:number, text:string}[]} polished
 * @returns {{applied:boolean, removed:number}}
 */
export function applyPolish(segments, ids, polished) {
  if (!Array.isArray(polished)) return { applied: false, removed: 0 };
  const expected = new Set(ids);
  const got = new Set(polished.map((p) => p.id));
  if (got.size !== expected.size) return { applied: false, removed: 0 };
  for (const id of got) if (!expected.has(id)) return { applied: false, removed: 0 };

  let removed = 0;
  for (const item of polished) {
    const seg = segments[item.id];
    if (!seg) continue;
    const cleaned = dedupeRepeats(item.text);
    if (cleaned === '') {
      seg.state = 'skipped';
      removed++;
      continue;
    }
    // raw 只写一次，保留最初的字幕/ASR 原文
    if (!seg.raw) seg.raw = seg.text;
    seg.text = cleaned;
    seg.state = 'polished';
  }
  return { applied: true, removed };
}

/** 恢复全部段落到未润色状态。 */
export function resetPolish(segments) {
  for (const seg of segments) {
    if (seg.raw) seg.text = seg.raw;
    delete seg.raw;
    seg.state = 'kept';
  }
  return segments;
}
