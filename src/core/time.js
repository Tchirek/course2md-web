//! 时间戳：解析与格式化。
// 与 course2md 的 fmt_ts / parse_timestamp 保持同一套语义，
// 这样插件产出的笔记能和 CLI 产出的笔记互相接续。

/**
 * mm:ss 或 h:mm:ss。负数与非有限值按 0 处理。
 * @param {number} sec
 * @returns {string}
 */
export function fmtTs(sec) {
  const s = Math.floor(Number.isFinite(sec) ? Math.max(0, sec) : 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/**
 * 宽容的时间戳解析（与 course2md 取同一超集）：
 * `HH:MM:SS` / `MM:SS` / 裸秒数，小数分隔符 `.` 或 `,`，
 * 容忍首尾空白、`[...]` 包裹与秒后缀 `s`（LLM 常输出 "120s"）。
 * 分/秒位 >= 60、负数、非有限值一律拒绝。
 * @param {string} value
 * @returns {number|null} 秒数；无法解析时为 null
 */
export function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim().replace(/^\[|\]$/g, '').trim();
  if (v.endsWith('s')) v = v.slice(0, -1);
  v = v.replace(/,/g, '.');
  const parts = v.split(':');
  if (parts.length === 0 || parts.length > 3) return null;
  let result = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    // 空段必须拒绝：Number('') === 0，否则 '' 和 '1:' 会被当成合法时间
    if (part === '' || !/^\d*\.?\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) return null;
    if (i > 0 && n >= 60) return null;
    result = result * 60 + n;
  }
  return result;
}

/**
 * 把秒数夹到 [0, max] 内；非有限值归 0。
 * @param {unknown} sec
 * @param {number} max
 */
export function clampTime(sec, max) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return 0;
  const cap = Number.isFinite(max) && max > 0 ? max : Infinity;
  return Math.min(n, cap);
}
