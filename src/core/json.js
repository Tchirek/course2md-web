//! 从混杂文本里抠出 JSON。
//! 两个调用方：解析 LLM 回复，以及读取页面 `<script>` 里的初始状态
//! （YouTube 的 ytInitialPlayerResponse、B 站的 __INITIAL_STATE__）。

/**
 * 从 `from` 处开始，按括号配对切出一个完整的 JSON 值。
 * 用状态机而不是正则：字符串里的 `}` 和转义引号都能正确跳过。
 *
 * @param {string} text
 * @param {number} from 起始位置（应为 `{` 或 `[`）
 * @returns {string|null} 切片，或 null（括号不配对 / 起点不是括号）
 */
export function sliceBalancedJson(text, from) {
  const source = String(text ?? '');
  const open = source[from];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return null;
}

/**
 * 抠出并解析第一个完整 JSON 值。
 * 容忍 Markdown 代码围栏与前后废话。
 *
 * @param {string} content
 * @returns {any|null}
 */
export function extractJson(content) {
  const text = String(content ?? '');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fence ? [fence[1], text] : [text];

  for (const candidate of candidates) {
    let cursor = 0;
    for (;;) {
      const start = candidate.slice(cursor).search(/[[{]/);
      if (start < 0) break;
      const at = cursor + start;
      const slice = sliceBalancedJson(candidate, at);
      if (slice === null) {
        cursor = at + 1;
        continue;
      }
      try {
        return JSON.parse(slice);
      } catch {
        cursor = at + 1;
      }
    }
  }
  return null;
}

/**
 * 从页面的 `<script>` 文本里取出 `var name = {...}` 的值。
 * 比直接找第一个 `{` 稳：会校验后面的内容确实是完整对象，并逐个候选尝试。
 *
 * @param {string} scriptText
 * @param {string} varName
 * @returns {any|null}
 */
export function readInlineJson(scriptText, varName) {
  const text = String(scriptText ?? '');
  const needle = new RegExp(`(?:var\\s+|window\\.|window\\[['"])?${escapeRegExp(varName)}`, 'g');
  let m;
  while ((m = needle.exec(text)) !== null) {
    let cursor = m.index + m[0].length;
    // 允许 `["name"]` / `.name` / ` name = ` 这几种写法
    const rest = text.slice(cursor);
    const eq = rest.search(/[:=]/);
    if (eq < 0) continue;
    cursor += eq + 1;
    const brace = text.slice(cursor).search(/[[{]/);
    if (brace < 0) continue;
    const at = cursor + brace;
    const slice = sliceBalancedJson(text, at);
    if (slice === null) continue;
    try {
      return JSON.parse(slice);
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** @param {unknown} s */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
