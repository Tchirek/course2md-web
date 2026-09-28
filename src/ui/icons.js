//! 手画的描边图标。
//!
//! 不用 AI 生成的粗糙图形，也不用 emoji。几何是量出来的：16 的 viewBox、
//! 1.5 的描边、圆头圆角，全部继承 currentColor —— 图标不套同色底、不做色块。
//! 需要新图标就往 ICONS 里加一条 path，保持同一套度量。

const ICONS = {
  check: 'M3.75 8.5 L6.5 11.25 L12.25 4.75',
  close: 'M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5',
  copy: 'M6 6.5 V4.5 h6 v6 h-2 M4 6.5 h6.5 v6 H4 z',
  download: 'M8 2.75 V10 M4.75 7 L8 10.25 L11.25 7 M3.5 13 h9',
  open: 'M6.75 3.5 h5.75 v5.75 M12.5 3.5 L7.5 8.5 M10.75 9.5 v3.25 h-8 v-8 h3.25',
  refresh: 'M12.75 8 a4.75 4.75 0 1 1 -1.4 -3.35 M12.9 3.25 v2.9 h-2.9',
  chevron: 'M6.25 4.5 L10 8 L6.25 11.5',
  settings:
    'M8 10.1 a2.1 2.1 0 1 0 0 -4.2 a2.1 2.1 0 0 0 0 4.2 M8 2.2 v1.6 M8 12.2 v1.6 M2.9 5.1 l1.15 .65 M11.95 10.25 l1.15 .65 M2.9 10.9 l1.15 -.65 M11.95 5.75 l1.15 -.65',
  clock: 'M8 4.5 V8 l2.4 1.6 M8 14 A6 6 0 1 0 8 2 A6 6 0 0 0 8 14',
  text: 'M3.5 4.5 h9 M3.5 8 h9 M3.5 11.5 h5.5',
  info: 'M8 7.5 v4 M8 4.75 v.6 M8 14 A6 6 0 1 0 8 2 A6 6 0 0 0 8 14',
  warn: 'M8 3 L14 13 H2 z M8 6.75 v3.25 M8 11.6 v.6',
};

/**
 * 建一个图标元素。
 * @param {keyof ICONS} name
 * @param {{size?:number, title?:string}} [opts]
 * @returns {SVGElement}
 */
export function icon(name, opts = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const size = opts.size ?? 16;
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.info);
  svg.appendChild(path);

  if (opts.title) {
    svg.setAttribute('role', 'img');
    svg.removeAttribute('aria-hidden');
    const t = document.createElementNS(ns, 'title');
    t.textContent = opts.title;
    svg.appendChild(t);
  }
  return svg;
}

/** 勾号图标是唯一填白的：它画在标记色的实心方框上。 */
export function checkGlyph() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  // 继承容器颜色：深色模式下 --mark 变亮，勾号必须跟着变深
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.25');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS.check);
  svg.appendChild(path);
  return svg;
}

export const ICON_NAMES = Object.keys(ICONS);
