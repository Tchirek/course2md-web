//! 输出渲染：Markdown / 纯文本 / 结构化 JSON。
// 时间戳写法刻意与 course2md 的 parse_timestamp 兼容：
// 可点击时用 `[mm:ss](...)`，不可点击时用 `[mm:ss]`——两种都能被它重新解析。

import { fmtTs } from './time.js';
import { SCHEMA_VERSION } from './model.js';

/**
 * 给链接加上跳转到指定秒的参数（与 course2md 的 ts_url_from 同规则）：
 * 覆盖已有的 t 参数、清掉 fragment；file: 链接用 #t= 片段。
 * @param {string} sourceUrl
 * @param {number} sec
 */
export function seekUrl(sourceUrl, sec) {
  const seconds = String(Math.floor(Math.max(0, sec)));
  try {
    const url = new URL(sourceUrl);
    if (url.protocol === 'file:') {
      url.hash = `t=${seconds}`;
      return url.toString();
    }
    const params = [...url.searchParams.entries()].filter(([k]) => k !== 't');
    url.search = '';
    for (const [k, v] of params) url.searchParams.append(k, v);
    url.searchParams.append('t', seconds);
    url.hash = '';
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

/**
 * 视频元信息（适配器给出；取不到的字段缺省）。
 * @typedef {object} Meta
 * @property {string} [title]
 * @property {string} [uploader]
 * @property {number} [duration]
 * @property {string} [url]
 * @property {string} [site]
 * @property {string} [videoId]
 * @property {number} [cid]
 * @property {string} [language]
 * @property {string} [source] 文字来源（model.js 的 SOURCE）
 */

/**
 * 一张画面：t 是讲述时刻；image 是数据地址或导出时的相对路径，还没取到时为空。
 * @typedef {{t: number, image?: string}} Frame
 */

/**
 * @typedef {object} DocSection
 * @property {string} [title]
 * @property {number} t
 * @property {number} [end]
 * @property {import('./model.js').Segment[]} segments
 * @property {Frame[]} [frames] 图文导出时才有
 */

/**
 * 生成时的显示选项，由 finalize（content/organize.js）记进文档，随结构化 JSON 导出。
 * @typedef {{showTimestamps?: boolean, imageLevel?: string, polished?: boolean}} DocOptions
 */

/**
 * @typedef {object} Doc
 * @property {number} schemaVersion
 * @property {{name:string, version:string}} generator
 * @property {Required<Meta> & DocOptions} meta
 * @property {DocSection[]} sections
 */

/**
 * @typedef {object} RenderOptions
 * @property {boolean} [timestamps] 是否显示讲述时刻
 * @property {boolean} [links]      时刻是否带跳转链接
 * @property {boolean} [frontMatter] 是否写 YAML front matter
 * @property {boolean} [images]      各節で取れた画面を段落の前に挟むか
 */

/**
 * 组装结构化文档。
 * @param {Meta} meta
 * @param {DocSection[]} sections
 * @returns {Doc}
 */
export function buildDoc(meta, sections) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'course2md-web', version: globalThis.chrome?.runtime?.getManifest?.().version ?? '0.0.0' },
    meta: {
      ...meta,
      title: meta.title ?? '',
      uploader: meta.uploader ?? '',
      duration: Number(meta.duration) || 0,
      url: meta.url ?? '',
      site: meta.site ?? '',
      videoId: meta.videoId ?? '',
      cid: meta.cid ?? 0,
      language: meta.language ?? '',
      source: meta.source ?? '',
    },
    sections: sections.map((s) => ({
      title: s.title ?? '',
      t: s.t,
      end: s.end,
      ...(s.frames ? { frames: s.frames.map((frame) => ({ ...frame })) } : {}),
      segments: s.segments
        .filter((seg) => seg.state !== 'skipped')
        .map((seg) => {
          /** @type {import('./model.js').Segment} */
          const out = { start: seg.start, end: seg.end, text: seg.text };
          if (seg.raw) out.raw = seg.raw;
          return out;
        }),
    })),
  };
}

/**
 * 渲染 Markdown。
 *
 * 观感取舍：正文是散文，元信息要能被一眼跳过。所以时间戳要么是可点击的链接
 * （渲染后自带颜色区分），要么是方括号包裹的裸时间戳；不给正文加粗、不上
 * 代码格式——等宽字体在 markdown 里是给代码用的。
 *
 * @param {Doc} doc
 * @param {RenderOptions} [opts]
 */
export function toMarkdown(doc, opts = {}) {
  const timestamps = opts.timestamps !== false;
  const links = timestamps && opts.links !== false;
  const meta = doc.meta;
  const url = meta.url || '';
  const out = [];

  if (opts.frontMatter) {
    out.push('---');
    if (meta.title) out.push(`title: ${yamlString(meta.title)}`);
    if (meta.uploader) out.push(`author: ${yamlString(meta.uploader)}`);
    if (url) out.push(`source: ${yamlString(url)}`);
    if (meta.duration) out.push(`duration: ${fmtTs(meta.duration)}`);
    out.push('---', '');
  }

  if (meta.title) out.push(`# ${inline(meta.title)}`, '');
  const facts = [];
  if (meta.uploader) facts.push(`- 作者：${inline(meta.uploader)}`);
  if (meta.duration) facts.push(`- 时长：${fmtTs(meta.duration)}`);
  if (url) facts.push(`- 来源：[${inline(url)}](${url})`);
  facts.push(
    `- 文字来源：${sourceLabel(meta.source)} · ${countSegments(doc)} 段`,
  );
  facts.push(`- 由 course2md-web 生成`);
  out.push(...facts, '', '---', '');

  for (const section of doc.sections) {
    const segments = section.segments.filter((s) => s.state !== 'skipped');
    if (!segments.length) continue;

    if (section.title) {
      out.push(`## ${heading(section.title, section.t, url, timestamps, links)}`, '');
    } else if (timestamps) {
      out.push(`## ${stamp(section.t, url, links)}`, '');
    }

    const frames = opts.images ? (section.frames ?? []).filter((f) => f.image).sort((a, b) => a.t - b.t) : [];
    let fi = 0;
    const writeFrame = (/** @type {Frame} */ frame) => out.push(`![视频 ${fmtTs(frame.t)} 的截图](${frame.image})`, '');

    for (const seg of segments) {
      while (fi < frames.length && frames[fi].t <= seg.start) writeFrame(frames[fi++]);
      const body = inline(seg.text);
      out.push(timestamps ? `${stamp(seg.start, url, links)} ${body}` : body, '');
    }
    while (fi < frames.length) writeFrame(frames[fi++]);
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 纯文本（贴进聊天窗口、笔记软件时用）。不含任何标记符号。
 * @param {{meta: Meta, sections: DocSection[]}} doc meta と sections しか使わない
 * @param {RenderOptions} [opts] 同 toMarkdown
 */
export function toPlainText(doc, opts = {}) {
  const timestamps = opts.timestamps !== false;
  const out = [];
  if (doc.meta.title) out.push(doc.meta.title, '');
  for (const section of doc.sections) {
    const segments = section.segments.filter((s) => s.state !== 'skipped');
    if (!segments.length) continue;
    if (section.title) out.push(section.title, '');
    for (const seg of segments) {
      out.push(timestamps ? `[${fmtTs(seg.start)}] ${seg.text}` : seg.text, '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 网页文档 JSON；course2md document.json 用 desktopSnapshot 显式转换。
 * @param {Doc} doc
 * @param {{pretty?: boolean}} [opts]
 */
export function toJson(doc, opts = {}) {
  return `${JSON.stringify(doc, opts.pretty === false ? undefined : null, 2)}\n`;
}

/**
 * @param {number} sec
 * @param {string} url
 * @param {boolean} links
 */
function stamp(sec, url, links) {
  const label = fmtTs(sec);
  if (links && url) return `[${label}](${seekUrl(url, sec)})`;
  return `[${label}]`;
}

/**
 * @param {string} title
 * @param {number} sec
 * @param {string} url
 * @param {boolean} timestamps
 * @param {boolean} links
 */
function heading(title, sec, url, timestamps, links) {
  if (!timestamps) return inline(title);
  return `${stamp(sec, url, links)} ${inline(title)}`;
}

/**
 * 标题行只 strip 换行与行首 `#`（防伪造标题），其余不转义——最坏是渲染偏差。
 * @param {unknown} s
 */
function inline(s) {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^#+/, '')
    .trim();
}

/** @param {unknown} s */
function yamlString(s) {
  return JSON.stringify(inline(s));
}

/** @param {Doc} doc */
function countSegments(doc) {
  return doc.sections.reduce(
    (n, s) => n + s.segments.filter((x) => x.state !== 'skipped').length,
    0,
  );
}

/** @param {unknown} source */
export function sourceLabel(source) {
  return source === 'asr' ? '语音转录' : '平台字幕';
}

/**
 * 文件名安全的标题。
 * @param {unknown} title
 * @param {string} [ext]
 */
export function fileNameFor(title, ext = 'md') {
  const base = String(title ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'notes'}.${ext}`;
}

/** @param {DocSection[]} sections @param {boolean} original */
export function shownSections(sections, original) {
  return original ? sections.map((section) => ({ ...section,
    segments: section.segments.map((p) => ({ ...p, text: p.raw ?? p.text, state: /** @type {const} */ ('kept') })) })) : sections;
}

/** @typedef {{schema: number, meta: {title: string, uploader: string, duration: number, webpage_url: string, extractor: string, id: string}, sections: {t: number, end: number, image: string, speech: import('./model.js').TranscriptEvent[]}[], summary?: {tldr: string, key_points: string[], outline: {t: number, title: string, detail: string}[]}|null}} DesktopDocument */

/**
 * 一段只归属一次；章节与所有图片保存在网页伴随文档中，course2md 每节只接收一张图。
 * @param {Doc} doc
 * @param {DocSection[]} sections
 */
export function desktopSnapshot(doc, sections) {
  /** @type {Record<string, string>} */
  const images = {};
  const web = buildDoc(doc.meta, sections);
  web.sections = sections.map((s) => ({ ...s, segments: s.segments.map((p) => ({ ...p })), frames: (s.frames ?? []).map((f) => ({ ...f })) }));
  web.generator = doc.generator;
  let count = 0;
  /** @type {Map<number, {data: string, path: string}>} */
  const framePaths = new Map();
  for (const section of web.sections) {
    for (const frame of section.frames ?? []) {
      if (!frame.image) continue;
      const previous = framePaths.get(frame.t);
      if (previous) {
        if (previous.data !== frame.image) throw new Error('同一时刻出现不同画面');
        frame.image = previous.path;
        continue;
      }
      const match = /^data:image\/(jpeg|png|webp);base64,/.exec(frame.image);
      if (!match) throw new Error('只能保存已取得的本机画面');
      const name = `frames/slide_${String(++count).padStart(4, '0')}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
      images[name] = frame.image;
      framePaths.set(frame.t, { data: frame.image, path: name });
      frame.image = name;
    }
  }
  const marks = new Map(web.sections.map((s) => [s.t, '']));
  for (const s of web.sections) for (const f of s.frames ?? []) if (f.image) marks.set(f.t, f.image);
  /** @type {DesktopDocument} */
  const document = {
    schema: 1,
    meta: { title: doc.meta.title ?? '', uploader: doc.meta.uploader ?? '', duration: doc.meta.duration ?? 0,
      webpage_url: doc.meta.url ?? '', extractor: doc.meta.site ?? '', id: doc.meta.videoId ?? '' },
    sections: [...marks].sort(([a], [b]) => a - b).map(([t, image]) => ({ t, end: 0, image, speech: [] })),
    summary: null,
  };
  const native = document.sections;
  const end = web.sections.flatMap((s) => s.segments).reduce((last, p) => Math.max(last, p.end), doc.meta.duration ?? 0);
  for (let i = 0; i < native.length; i++) native[i].end = native[i + 1]?.t ?? Math.max(end, native[i].t);
  let index = 0;
  const shown = shownSections(web.sections, doc.meta.polished === false);
  for (const p of shown.flatMap((s) => s.segments).filter((p) => p.state !== 'skipped').sort((a, b) => a.start - b.start)) {
    const mid = (p.start + p.end) / 2;
    // ponytail: linear scan per paragraph keeps out-of-order/overlapping cue midpoints correct.
    index = 0;
    while (index + 1 < native.length && native[index + 1].t <= mid) index++;
    native[index]?.speech.push({ start: p.start, end: p.end, text: p.text, ...(p.raw !== undefined ? { raw: p.raw } : {}) });
  }
  return { document, web, images, markdown: toMarkdown({ ...web, sections: shown }, { timestamps: doc.meta.showTimestamps, images: true }) };
}
