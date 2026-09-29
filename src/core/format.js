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
 * @typedef {object} Doc
 * @property {number} schemaVersion
 * @property {{name:string, version:string}} generator
 * @property {object} meta
 * @property {object[]} sections
 */

/**
 * 组装结构化文档。
 * @param {object} meta  { title, uploader, duration, url, site, language }
 * @param {{title?:string, t:number, end:number, segments:object[]}[]} sections
 */
export function buildDoc(meta, sections) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'course2md-web', version: '0.1.0' },
    meta: {
      title: meta.title ?? '',
      uploader: meta.uploader ?? '',
      duration: Number(meta.duration) || 0,
      url: meta.url ?? '',
      site: meta.site ?? '',
      language: meta.language ?? '',
      source: meta.source ?? '',
    },
    sections: sections.map((s) => ({
      title: s.title ?? '',
      t: s.t,
      end: s.end,
      segments: s.segments
        .filter((seg) => seg.state !== 'skipped')
        .map((seg) => {
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
 * @param {object} [opts]
 * @param {boolean} [opts.timestamps] 是否显示讲述时刻
 * @param {boolean} [opts.links]      时刻是否带跳转链接
 * @param {boolean} [opts.frontMatter] 是否写 YAML front matter
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

    // 图片帧按时刻落在同起点的段落之前
    const frames = opts.images ? (section.frames ?? []).filter((f) => f.image) : [];

    for (const seg of segments) {
      for (const frame of frames) {
        if (frame.t === seg.start) out.push(`![视频 ${fmtTs(frame.t)} 的截图](${frame.image})`, '');
      }
      const body = inline(seg.text);
      out.push(timestamps ? `${stamp(seg.start, url, links)} ${body}` : body, '');
    }
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 纯文本（贴进聊天窗口、笔记软件时用）。不含任何标记符号。
 * @param {Doc} doc
 * @param {object} [opts] 同 toMarkdown
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

/** 结构化 JSON，字段名与 course2md 的 structured.json 对齐。 */
export function toJson(doc, opts = {}) {
  return `${JSON.stringify(doc, opts.pretty === false ? undefined : null, 2)}\n`;
}

function stamp(sec, url, links) {
  const label = fmtTs(sec);
  if (links && url) return `[${label}](${seekUrl(url, sec)})`;
  return `[${label}]`;
}

function heading(title, sec, url, timestamps, links) {
  if (!timestamps) return inline(title);
  return `${stamp(sec, url, links)} ${inline(title)}`;
}

/** 标题行只 strip 换行与行首 `#`（防伪造标题），其余不转义——最坏是渲染偏差。 */
function inline(s) {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^#+/, '')
    .trim();
}

function yamlString(s) {
  return JSON.stringify(inline(s));
}

function countSegments(doc) {
  return doc.sections.reduce(
    (n, s) => n + s.segments.filter((x) => x.state !== 'skipped').length,
    0,
  );
}

export function sourceLabel(source) {
  return source === 'asr' ? '本地模型转录' : '平台字幕';
}

/** 文件名安全的标题。 */
export function fileNameFor(title, ext = 'md') {
  const base = String(title ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'notes'}.${ext}`;
}
