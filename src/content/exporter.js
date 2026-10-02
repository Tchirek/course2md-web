//! 書き出し：Markdown・純テキスト・画像付きの一式を、コントローラの状態から組み立てる純関数。

import { toMarkdown, toPlainText, shownSections } from '../core/format.js';

/** @typedef {import('../core/format.js').Doc} Doc */
/** @typedef {import('../core/format.js').DocSection} DocSection */
/** @typedef {import('../core/settings.js').Settings} Settings */

/**
 * 生成済みの文書を Markdown にする。
 * @param {Doc|null} doc
 * @param {Settings} settings
 * @param {DocSection[]} [sections] 完整段落；切回原文时恢复润色删除的段落
 */
export function markdownOf(doc, settings, sections = doc?.sections ?? []) {
  if (!doc) return '';
  return toMarkdown({ ...doc, sections: shownSections(sections, !settings.polish) }, { timestamps: settings.showTimestamps });
}

/**
 * 純テキスト。文字起こしの途中でも、出来ている節まで書き出せる。
 * 整形を切っているときは原文（raw）を使う。
 * @param {import('../core/format.js').Meta|null} meta
 * @param {DocSection[]|null|undefined} sections
 * @param {Settings} settings
 */
export function plainTextOf(meta, sections, settings) {
  if (!sections?.some((section) => section.segments.some((seg) => seg.raw ?? seg.text))) return '';
  const shown = shownSections(sections, !settings.polish);
  return toPlainText({ meta: meta ?? {}, sections: shown }, { timestamps: settings.showTimestamps });
}

/**
 * 画像付きで保存するときの一式。画像を出さない設定なら null。
 * 残した段落に掛かる画面だけを、現れる順に番号を振って書き出す。
 * @param {Doc} doc
 * @param {DocSection[]} previewSections 面板上显示的分节（带已取到的帧）
 * @param {Settings} settings
 * @returns {{markdown: string, images: string[]}|null}
 */
export function imageBundle(doc, previewSections, settings) {
  if (settings.imageLevel === 'none') return null;
  /** @type {string[]} */
  const images = [];
  const sections = shownSections(previewSections, !settings.polish)
    .filter((section) => section.segments.some((seg) => seg.state !== 'skipped'))
    .map((section) => ({
      ...section,
      frames: (section.frames ?? [])
        // Real CLI timestamps do not have to equal paragraph boundaries.
        .filter(/** @returns {frame is {t: number, image: string}} */ (frame) =>
          Boolean(frame.image))
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
