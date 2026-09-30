//! 字幕解析：VTT / SRT / YouTube json3 / timedtext XML / B 站 JSON。
//!
//! 全部解析到统一的 TranscriptEvent，下游（段落组织、润色、渲染）不再关心来源。
//! 与 course2md 的 subtitle.rs 同一策略：平台字幕优先，ASR 兜底。

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' };

/**
 * 解码常见的 HTML 实体与 VTT 转义。
 * 只扫一遍：逐个替换会让 `&amp;#60;` 先变成 `&#60;` 再被解成 `<`（二次解码）。
 * 认不出的实体、超出 Unicode 范围的码点原样保留。
 */
export function decodeEntities(s) {
  return String(s).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
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
 * 以及 YouTube 自动字幕的滚动重复（见 collapseCues）。
 * @param {string} text
 */
export function parseVtt(text) {
  return collapseCues(readCues(text, true));
}

/**
 * SRT：可选序号行 + 时间轴（逗号小数）+ 文本。
 * @param {string} text
 */
export function parseSrt(text) {
  return collapseCues(readCues(text, false));
}

/**
 * @typedef {{start:number, end:number, lines:string[]}} Cue
 */

/**
 * VTT / SRT の cue を読む。本文は行ごとに整え、空行は落とす（行の区切りは滚动の判定に使う）。
 * 本文が空の cue も残す：流れる字幕ではそれが「画面を消した」印になる。
 * @param {string} text
 * @param {boolean} vtt NOTE/STYLE/REGION/WEBVTT のブロックを読み飛ばすか
 * @returns {Cue[]}
 */
function readCues(text, vtt) {
  const body = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  // 块之间用空行分隔
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (vtt && /^(NOTE|STYLE|REGION|WEBVTT)\b/i.test(lines[0].trim())) continue;
    // cue id 行可有可无，时间轴行是第一条含 --> 的行
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [rawStart, rest] = lines[timeIdx].split('-->');
    const start = parseCueTime(rawStart);
    // 时间轴后面可能跟 "align:start position:0%" 之类的设置，取第二段里的第一个时间
    const end = parseCueTime(rest.trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;
    cues.push({ start, end, lines: lines.slice(timeIdx + 1).map(cleanCueText).filter((line) => line !== '') });
  }
  return cues;
}

/**
 * YouTube json3（`baseUrl + &fmt=json3`）。
 * 没有 segs 的事件是定位/换行事件，跳过。
 *
 * 去重はしない。自動字幕の json3 も一語ずつ新しい文字だけを運び、同じ文字を二度は運ばない
 * （二行表示のため時間は前後の事件と重なるが、それは表示の都合で繰り返しではない）。
 * 実物の 43 分の講義で確かめた：以前の重なり併合は json3 に 30 か所の誤りを作っていた。
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
  return events;
}

/**
 * 旧式 timedtext XML：`<text start="1.5" dur="2">…</text>`。
 * 用正则而不是 DOMParser——这个格式是扁平的，正则够用且能在 Node 里测。
 * json3 と同じ中身の旧形式なので、同じく去重はしない。
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
  return events;
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
  // 一文ずつの字幕で、流れる形式ではない
  return sortByStart(events);
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
 * VTT / SRT の cue を事件にまとめる。
 *
 * YouTube 自動字幕の VTT は「行送り」式に流れる：各 cue は前の cue の最後の行をそのまま
 * 一行目に繰り返し、二行目に新しい語を足す（間に 10ms の「保持」cue が挟まる）。
 *     the following content is provided under
 *     the following content is provided under / a Creative Commons license your support
 * 繰り返しは必ず**行単位**で起きる。以前は文字単位で「前の末尾 = 次の先頭」を探して繋いでいたが、
 * 人手の字幕では首尾が接しているだけの別々の文まで繋ぎ（"So this is the plan" + "and then…"
 * → "pland then…"、README を 7 語ずつ切った cue で 2.7% の境目）、YouTube の VTT でも本当の
 * 繰り返し（"okay okay"）を落としていた。
 *
 * そこで二段構え：
 *  1. 流れる字幕かどうかを cue 列そのものから判定する（looksRolling）。人手の字幕は前の行を
 *     繰り返さないので、ここで弾かれる。
 *  2. 流れる字幕なら、前の cue に出ていた行（または語の切れ目で伸びた行）だけを落とす。
 *     そうでなければ原版 course2md と同じく、時間の切れ目なく続く同一文だけを一つにする。
 * @param {Cue[]} cues
 */
export function collapseCues(cues) {
  return looksRolling(cues) ? collapseRolling(cues) : mergeRepeats(cues);
}

/** 流れる字幕の隣り合う cue とみなす最大の間隔（実物は 0）。 */
const ROLLING_GAP_SECS = 0.6;

/**
 * 隣り合う cue の半数以上（かつ 2 組以上）が前の行を繰り返していれば、流れる字幕。
 * 実物の YouTube 自動字幕では 2006 組中 1914 組が当てはまる。
 * @param {Cue[]} cues
 */
export function looksRolling(cues) {
  let pairs = 0;
  let repeats = 0;
  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1];
    const cue = cues[i];
    if (!prev.lines.length || !cue.lines.length || cue.start < prev.start || cue.start - prev.end >= ROLLING_GAP_SECS) continue;
    pairs++;
    if (repeatedLines(prev.lines, cue.lines) || extendsLine(prev.lines.at(-1), cue.lines[0])) repeats++;
  }
  return repeats >= 2 && repeats * 2 >= pairs;
}

/** @param {Cue[]} cues */
function collapseRolling(cues) {
  /** @type {{start:number, end:number, text:string}[]} */
  const out = [];
  // 今画面に出ている行（直前の cue の行）
  /** @type {string[]} */
  let shown = [];
  for (const cue of cues) {
    const prev = out.at(-1);
    let fresh = cue.lines;
    if (!fresh.length) {
      // 画面が消えた：次の cue の行はどれも新しい（実物では、消えた後にもう一度言った "okay" がこの形）
      shown = [];
      continue;
    }
    if (prev && cue.start >= prev.start && cue.start - prev.end < ROLLING_GAP_SECS) {
      const repeated = repeatedLines(shown, fresh);
      fresh = fresh.slice(repeated);
      const last = shown.at(-1);
      if (!repeated && last !== undefined && extendsLine(last, fresh[0])) {
        // 一行が語の切れ目で伸びた（逐次表示の字幕）：伸びた分だけ前の事件に足す
        prev.text = `${prev.text}${fresh[0].slice(last.length)}`.replace(/\s+/g, ' ');
        prev.end = Math.max(prev.end, cue.end);
        fresh = fresh.slice(1);
      }
    }
    shown = cue.lines;
    if (!fresh.length) {
      if (prev) prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    out.push({ start: cue.start, end: cue.end, text: fresh.join(' ') });
  }
  return out;
}

/**
 * 流れない字幕：時間の切れ目なく続く同一文だけを一つにする（原版 subtitle.rs と同じ）。
 * @param {Cue[]} cues
 */
function mergeRepeats(cues) {
  /** @type {{start:number, end:number, text:string}[]} */
  const out = [];
  for (const cue of cues) {
    if (!cue.lines.length) continue;
    const text = cue.lines.join(' ');
    const prev = out.at(-1);
    if (prev && prev.text === text && cue.start >= prev.start && cue.start <= prev.end) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    out.push({ start: cue.start, end: cue.end, text });
  }
  return out;
}

/**
 * shown の末尾 k 行と lines の先頭 k 行が一致する最大の k（行送りで繰り返された行の数）。
 * @param {string[]} shown
 * @param {string[]} lines
 */
function repeatedLines(shown, lines) {
  for (let k = Math.min(shown.length, lines.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = shown[shown.length - k + i] === lines[i];
    if (same) return k;
  }
  return 0;
}

/**
 * line が prev をそのまま伸ばしたものか。伸びた所が語の切れ目でなければ別の語
 * （"going to" → "going together"）なので認めない。
 * @param {string|undefined} prev
 * @param {string|undefined} line
 */
function extendsLine(prev, line) {
  if (!prev || !line || prev.length < 2 || line.length <= prev.length || !line.startsWith(prev)) return false;
  return wordBoundary(prev[prev.length - 1], line[prev.length]);
}

/** 語を空白で区切らない文字（漢字・かな・タイ文字）。これらの間はどこでも語の切れ目になりうる。 */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const SEPARATOR = /[\s\p{P}]/u;

/**
 * @param {string} before
 * @param {string} after
 */
function wordBoundary(before, after) {
  return SEPARATOR.test(before) || SEPARATOR.test(after) || (UNSPACED.test(before) && UNSPACED.test(after));
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
 * 字幕の終端が動画の長さを明らかに超えるか。字幕ファイル自体には動画を示す情報が
 * ないため、取得元が別動画の字幕を返しても内容からは見分けられない。時間軸だけは
 * 独立に照合できるので、終端が長さ + 5% + 10 秒を超える字幕は別動画のものとみなす。
 * 長さが不明（0 やライブ）の場合は判定しない。
 * @param {{start:number, end:number}[]} events
 * @param {number} duration 動画の長さ（秒）
 */
export function overrunsDuration(events, duration) {
  if (!(Number(duration) > 0) || !events.length) return false;
  const last = events.reduce((max, e) => Math.max(max, Number(e.end) || 0, Number(e.start) || 0), 0);
  return last > duration * 1.05 + 10;
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
