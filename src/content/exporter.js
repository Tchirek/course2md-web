//! 書き出し：Markdown・純テキスト・画像付きの一式を、コントローラの状態から組み立てる純関数。

import { toMarkdown, toPlainText } from '../core/format.js';

/** 生成済みの文書を Markdown にする。 */
export function markdownOf(doc, settings) {
  if (!doc) return '';
  return toMarkdown(doc, { timestamps: settings.showTimestamps });
}

/**
 * 純テキスト。文字起こしの途中でも、出来ている節まで書き出せる。
 * 整形を切っているときは原文（raw）を使う。
 */
export function plainTextOf(meta, sections, settings) {
  if (!sections?.some((section) => section.segments.some((seg) => seg.raw ?? seg.text))) return '';
  const original = !settings.polish;
  const shown = sections.map((section) => ({
    ...section,
    segments: section.segments.map((seg) => ({
      ...seg,
      text: original ? (seg.raw ?? seg.text) : seg.text,
      state: original ? 'kept' : seg.state,
    })),
  }));
  return toPlainText({ meta, sections: shown }, { timestamps: settings.showTimestamps });
}

/**
 * 画像付きで保存するときの一式。画像を出さない設定なら null。
 * 残した段落に掛かる画面だけを、現れる順に番号を振って書き出す。
 * @returns {{markdown: string, images: string[]}|null}
 */
export function imageBundle(doc, previewSections, settings) {
  if (settings.imageLevel === 'none') return null;
  const images = [];
  const sections = previewSections
    .filter((section) => section.segments.some((seg) => seg.state !== 'skipped'))
    .map((section) => ({
      ...section,
      frames: (section.frames ?? [])
        .filter((frame) => frame.image && section.segments.some((seg) => seg.state !== 'skipped' && seg.start === frame.t))
        .map((frame) => {
          images.push(frame.image);
          return { ...frame, image: `frames/slide_${String(images.length).padStart(4, '0')}.jpg` };
        }),
    }));
  if (!images.length) throw new Error('未能取得离线视频画面，请检查本机助手与媒体下载。');
  return {
    markdown: toMarkdown({ ...doc, sections }, { timestamps: settings.showTimestamps, images: true }),
    images,
  };
}
