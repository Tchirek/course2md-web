//! 事件を節と段落にまとめ、最終的な文書にする。字幕と文字起こしの両方の流れで使う。

import { coalesce, partitionByBoundaries } from '../core/paragraphs.js';
import { buildDoc } from '../core/format.js';
import { normalizeChapters } from '../core/subtitles.js';

let biliConverter;
export async function simplifyBilibili(events, site) {
  if (site !== 'bilibili') return;
  biliConverter ??= import('../vendor/opencc-t2cn.js').then(({ Converter }) => Converter({ from: 't', to: 'cn' }));
  const convert = await biliConverter;
  for (const event of events) event.text = convert(event.text);
}

/**
 * 事件 -> 分节 -> 段落。
 *
 * 导出的文字有章节就按章节分节，没有章节就整体一节。
 * 面板的画面段落由 visual.js 单独生成。
 *
 * @param {import('../core/model.js').TranscriptEvent[]} events
 * @param {object} meta
 * @param {object} opts 传给 coalesce
 */
export function organize(events, meta, opts = {}) {
  const chapters = normalizeChapters(meta.chapters ?? []);
  const mediaEnd = Number(meta.duration) || 0;

  let sections;
  if (chapters.length) {
    sections = partitionByBoundaries(events, chapters.map((c) => c.t), {
      ...opts,
      mediaEnd,
    }).map((section, i) => ({ ...section, title: chapters[i]?.title ?? '' }));
  } else {
    sections = [{ t: 0, end: mediaEnd, title: '', segments: coalesce(events, opts) }];
  }

  // 平坦列表与 sections 里的段落共享同一批对象引用，润色就地生效
  const segments = [];
  const sectionIndexOf = [];
  sections.forEach((section, i) => {
    for (const seg of section.segments) {
      seg.text = punctuate(seg.text);
      if (seg.raw) seg.raw = punctuate(seg.raw);
      segments.push(seg);
      seg.id = segments.length - 1;
      sectionIndexOf.push(i);
    }
  });

  return { sections, segments, sectionIndexOf, chapters };
}

/**
 * 事件列表 -> 章节下标（与 partitionByBoundaries 的中点归属一致）。
 * 转录进行中就能算，用于在组织成段落之前先润色事件。
 */
export function eventSectionIndexOf(events, meta) {
  const marks = [...new Set((meta?.chapters ?? [])
    .map((c) => Number(c?.t))
    .filter((n) => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
  if (!marks.length) return events.map(() => 0);
  return events.map((e) => {
    const mid = (Number(e.start) + Number(e.end)) / 2;
    let idx = 0;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i] <= mid) idx = i;
      else break;
    }
    return idx;
  });
}

function punctuate(text) {
  const value = String(text ?? '').trim();
  if (!value || /[。！？.!?；;][”’"')）】]*$/u.test(value)) return value;
  const mark = /[A-Za-z0-9]$/u.test(value) ? '.' : '。';
  return value.replace(/[，,、：:]$/u, '') + mark;
}

/** 由 pipeline 结果生成最终文档。 */
export function finalize(built, meta, settings) {
  // stats 由两个 pipeline 各自填；这里兜一层，避免调用方少传一个字段就崩
  const source = built?.stats?.source ?? settings?.source ?? 'subtitle';
  const doc = buildDoc({ ...meta, source }, built?.sections ?? []);
  doc.meta.showTimestamps = settings.showTimestamps;
  doc.meta.imageLevel = settings.imageLevel;
  doc.meta.polished = Boolean(settings.polish);
  return doc;
}
