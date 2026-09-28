//! 字幕解析：VTT / SRT / YouTube json3 / timedtext XML / B 站 JSON。
//!
//! 全部解析到统一的 TranscriptEvent，下游（段落组织、润色、渲染）不再关心来源。
//! 与 course2md 的 subtitle.rs 同一策略：平台字幕优先，ASR 兜底。

/** 解码常见的 HTML 实体与 VTT 转义。 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/**
 * 去掉字幕里的标记：`<v Speaker>`、`<c.classname>`、`<00:00:01.000>`（卡拉OK）、
 * `<i>`/`<b>`/`<font>` 等。保留文字。
 */
export function stripTags(s) {
  return String(s)
    .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/<[^>]*>/g, '');
}

/** 一个 cue 的文本清理：去标记、解码实体、压掉行内多余空白、合并换行为空格。 */
export function cleanCueText(raw) {
  return decodeEntities(stripTags(raw))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** 解析 `HH:MM:SS.mmm` / `MM:SS.mmm` / `SS.mmm`（VTT 用点，SRT 用逗号）。 */
export function parseCueTime(value) {
  const text = String(value).trim().replace(',', '.');
  const m = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (m) {
    const [, h = '0', mm, ss, frac = '0'] = m;
    return (
      Number(h) * 3600 +
      Number(mm) * 60 +
      Number(ss) +
      Number(frac.padEnd(3, '0')) / 1000
    );
  }
  const bare = Number(text);
  return Number.isFinite(bare) && bare >= 0 ? bare : null;
}

/**
 * WebVTT。处理 NOTE/STYLE/REGION 块、cue 标识行、时间轴后的定位设置、
 * 以及 YouTube 自动字幕的滚动重复（`<c>` 逐词高亮会产生同一句反复出现）。
 * @param {string} text
 */
export function parseVtt(text) {
  const body = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const events = [];
  // 块之间用空行分隔；NOTE/STYLE/REGION 整块丢弃
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (/^(NOTE|STYLE|REGION|WEBVTT)\b/i.test(lines[0].trim())) continue;

    let timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) {
      // 单行块里可能直接是时间轴（无 cue id）
      timeIdx = lines.findIndex((l) => /-->/.test(l));
      if (timeIdx < 0) continue;
    }
    const [rawStart, rest] = lines[timeIdx].split('-->');
    if (rest === undefined) continue;
    const start = parseCueTime(rawStart);
    // 时间轴后面可能跟 "align:start position:0%" 之类的设置，取第二段里的第一个时间
    const endToken = rest.trim().split(/\s+/)[0];
    const end = parseCueTime(endToken);
    if (start === null || end === null) continue;

    const textLines = lines.slice(timeIdx + 1);
    const cleaned = cleanCueText(textLines.join('\n'));
    if (cleaned === '') continue;
    events.push({ start, end, text: cleaned });
  }
  return dedupeRolling(events);
}

/**
 * SRT：可选序号行 + 时间轴（逗号小数）+ 文本。
 * @param {string} text
 */
export function parseSrt(text) {
  const body = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const events = [];
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [rawStart, rest] = lines[timeIdx].split('-->');
    const start = parseCueTime(rawStart);
    const end = parseCueTime(rest.trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;
    const cleaned = cleanCueText(lines.slice(timeIdx + 1).join('\n'));
    if (cleaned === '') continue;
    events.push({ start, end, text: cleaned });
  }
  return dedupeRolling(events);
}

/**
 * YouTube json3（`baseUrl + &fmt=json3`）。
 * 没有 segs 的事件是定位/换行事件，跳过。
 * @param {string|object} input
 */
export function parseJson3(input) {
  const data = typeof input === 'string' ? safeJson(input) : input;
  const raw = data?.events;
  if (!Array.isArray(raw)) return [];

  const events = [];
  for (const ev of raw) {
    if (!Array.isArray(ev?.segs)) continue;
    const text = cleanCueText(ev.segs.map((s) => s?.utf8 ?? '').join(''));
    if (text === '') continue;
    const start = Number(ev.tStartMs) / 1000;
    if (!Number.isFinite(start)) continue;
    const duration = Number(ev.dDurationMs) / 1000;
    events.push({
      start,
      end: Number.isFinite(duration) && duration > 0 ? start + duration : start,
      text,
    });
  }
  return dedupeRolling(events);
}

/**
 * 旧式 timedtext XML：`<text start="1.5" dur="2">…</text>`。
 * 用正则而不是 DOMParser——这个格式是扁平的，正则够用且能在 Node 里测。
 * @param {string} text
 */
export function parseTimedTextXml(text) {
  const body = String(text);
  if (!/<text\b/i.test(body)) return [];
  const events = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const attrs = m[1];
    const start = Number(attr(attrs, 'start'));
    const dur = Number(attr(attrs, 'dur'));
    if (!Number.isFinite(start)) continue;
    const cleaned = cleanCueText(m[2]);
    if (cleaned === '') continue;
    events.push({
      start,
      end: Number.isFinite(dur) && dur > 0 ? start + dur : start,
      text: cleaned,
    });
  }
  return dedupeRolling(events);
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

/**
 * B 站字幕：`{ body: [{ from, to, content }] }`。
 * @param {string|object} input
 */
export function parseBilibili(input) {
  const data = typeof input === 'string' ? safeJson(input) : input;
  const raw = data?.body;
  if (!Array.isArray(raw)) return [];

  const events = [];
  for (const item of raw) {
    const start = Number(item?.from);
    const end = Number(item?.to);
    const text = cleanCueText(item?.content ?? '');
    if (!Number.isFinite(start) || text === '') continue;
    events.push({
      start,
      end: Number.isFinite(end) && end >= start ? end : start,
      text,
    });
  }
  return dedupeRolling(sortByStart(events));
}

/**
 * 自动识别格式并解析。
 * @param {string} text
 */
export function parseSubtitle(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const head = text.slice(0, 4096);

  if (/^\s*\{/.test(text) || /"events"\s*:/.test(head)) {
    const asJson3 = parseJson3(text);
    if (asJson3.length) return asJson3;
    const asBili = parseBilibili(text);
    if (asBili.length) return asBili;
  }
  if (/WEBVTT/i.test(head) || /-->/.test(head)) {
    // 有 WEBVTT 头按 VTT 走，否则按 SRT（两者的时间轴差异由 parseCueTime 吸收）
    return /WEBVTT/i.test(head) ? parseVtt(text) : parseSrt(text);
  }
  return parseTimedTextXml(text);
}

/**
 * 滚动字幕去重。
 *
 * YouTube 自动字幕、部分平台 VTT 是「滑动窗口」式的：同一句话会被切成若干条
 * 时间上重叠的 cue 连续出现，例如
 *     大家好 / 大家好今天 / 今天讲线性代数
 * 只做前缀比较不够——第三条与第二条共享的是**边界**「今天」，不是前缀。
 * 所以这里既处理包含关系，也做后缀-前缀重叠合并。
 *
 * 两道保险，避免把讲师真的重复的话删掉：
 *  1. 只在时间紧邻（间隔 < 0.6s）时合并；
 *  2. 重叠至少要 2 个字符，否则视为无关，各留各的。
 */
export function dedupeRolling(events) {
  const out = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (prev && ev.start - prev.end < ROLLING_GAP_SECS && ev.start >= prev.start) {
      const merged = mergeRolling(prev.text, ev.text);
      if (merged !== null) {
        prev.text = merged;
        prev.end = Math.max(prev.end, ev.end);
        continue;
      }
    }
    out.push({ ...ev });
  }
  return out;
}

/** 判定为同一句滚动重复的最大时间间隔。 */
const ROLLING_GAP_SECS = 0.6;
/** 认作同一次滚动的最小重叠字符数。 */
const MIN_OVERLAP_CHARS = 2;

/**
 * 合并两条候选文本；无关时返回 null。
 *
 * 每种合并都要「共享部分 >= 2 个字符」才算数——否则「好」+「好奇」这种
 * 恰好同字开头但其实是两句话的情况会被误合并，直接丢字。
 * @param {string} a 已累积的文本
 * @param {string} b 新文本
 */
function mergeRolling(a, b) {
  if (a === b) return a;
  const A = [...a];
  const B = [...b];
  const aa = A.join('');
  const bb = B.join('');

  let shared = 0;
  const maxPrefix = Math.min(A.length, B.length);
  while (shared < maxPrefix && A[shared] === B[shared]) shared++;

  // 前缀延长：短的那条必须本身够长，才承认它是被延长的同一句
  if (shared === A.length && A.length >= MIN_OVERLAP_CHARS) return bb;
  if (shared === B.length && B.length >= MIN_OVERLAP_CHARS) return aa;

  // 包含关系
  if (A.length >= MIN_OVERLAP_CHARS && bb.includes(aa)) return bb;
  if (B.length >= MIN_OVERLAP_CHARS && aa.includes(bb)) return aa;

  // 滑动窗口：找最大的 k，使 a 的后缀恰好等于 b 的前缀
  for (let k = Math.min(A.length, B.length); k >= MIN_OVERLAP_CHARS; k--) {
    if (A.slice(A.length - k).join('') === B.slice(0, k).join('')) {
      return aa + B.slice(k).join('');
    }
  }
  return null;
}

function sortByStart(events) {
  return events
    .map((e, i) => [e, i])
    .sort((a, b) => a[0].start - b[0].start || a[1] - b[1])
    .map(([e]) => e);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 章节：解析 `<track kind="chapters">` 的 VTT，或 YouTube/B 站给的章节数组。
 * @param {string} vtt
 * @returns {{title:string, t:number}[]}
 */
export function parseChaptersVtt(vtt) {
  const events = parseVtt(vtt);
  return events.map((e) => ({ title: e.text, t: e.start }));
}

/**
 * 把一组 `{title, t}` 章节规整为可用的时间边界：去重、排序、补 0 起点。
 * @param {{title:string, t:number}[]} chapters
 */
export function normalizeChapters(chapters) {
  const list = (chapters ?? [])
    .filter((c) => c && Number.isFinite(c.t) && c.t >= 0)
    .map((c) => ({ title: cleanCueText(c.title ?? '') || '未命名章节', t: c.t }))
    .sort((a, b) => a.t - b.t);

  const seen = new Set();
  const out = [];
  for (const c of list) {
    const key = Math.round(c.t * 10);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  // 第一章不在 0 秒时，把开头也归入它，避免出现没有归属的开头片段
  return out;
}

/** 语言代码 -> 中文可读标签（设置页与轨道选择器用）。 */
export function languageLabel(code) {
  const raw = String(code ?? '').trim();
  if (!raw) return '未知语言';
  const lower = raw.toLowerCase();
  const table = {
    zh: '中文', 'zh-hans': '简体中文', 'zh-cn': '简体中文',
    'zh-hant': '繁体中文', 'zh-tw': '繁体中文', 'zh-hk': '繁体中文',
    en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语',
    es: '西班牙语', ru: '俄语', pt: '葡萄牙语', it: '意大利语', ar: '阿拉伯语',
  };
  if (table[lower]) return table[lower];
  const base = lower.split(/[-_]/)[0];
  if (table[base]) return `${table[base]}（${raw}）`;
  return raw;
}
