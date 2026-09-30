//! The panel's scrolling body: sections, paragraphs and frames reconciled in place.
//!
//! Nodes are reused across updates and never detached, so the browser's native scroll
//! anchoring keeps the paragraph being read still while frames are added or removed.

import { fmtTs } from '../core/time.js';
import { progress } from '../ui/controls.js';
import { el } from './panel-dom.js';

export class PanelBody {
  /** @param {import('./panel.js').Panel} panel */
  constructor(panel) {
    this.panel = panel;
    /** @type {HTMLElement|null} */
    this.el = null;
  }

  render() {
    // 滚动容器复用同一个节点，不随重建更换：换节点会打断进行中的滚轮手势
    // （图片批量到达时正好滚一半就被锁住）。
    // 分节按 t 复用、段落在节内只增不搬、图片按 t 对账插拔——段落节点
    // 从不脱离文档，浏览器原生滚动锚定的锚点恒定存活：图片的插入/移除
    // 由锚定补偿，阅读位置纹丝不动。密度切换不重建结构，只是图多图少。
    const body = this.el?.isConnected ? this.el : el('div', 'c2md-panel-body');
    this.el = body;
    const { status, sections, settings } = this.panel.state;

    // The two empty states share one class, so tell them apart by kind: checking the class
    // alone left "暂无笔记" in place for the whole wait when a run started from an idle panel.
    if ((status === 'loading' || status === 'running') && !sections?.length) {
      if (!body.querySelector('.c2md-empty[data-kind="loading"]')) {
        const empty = el('div', 'c2md-empty');
        empty.dataset.kind = 'loading';
        empty.appendChild(progress({ ratio: null, label: '正在取文字' }));
        body.replaceChildren(empty);
      }
      return body;
    }
    if (!sections?.length) {
      if (status !== 'error' && !body.querySelector('.c2md-empty[data-kind="none"]')) {
        const empty = el('div', 'c2md-empty');
        empty.dataset.kind = 'none';
        empty.textContent = '暂无笔记';
        body.replaceChildren(empty);
      }
      return body;
    }

    const polished = Boolean(settings?.polish && this.panel.state.polish?.hasResult);
    const level = settings?.imageLevel;

    const existing = new Map();
    for (const child of [...body.children]) {
      if (!child.classList?.contains('c2md-section')) { child.remove(); continue; }
      const key = child.dataset.t;
      if (key !== undefined && !existing.has(key)) existing.set(key, child);
      else child.remove();
    }

    const shown = sections.filter((section) => section.segments.some((seg) => seg.raw ?? seg.text));
    const keyOf = (section) => String(section.t ?? section.segments[0]?.start ?? 0);
    const usedKeys = new Set(shown.map(keyOf));
    // 不要になった節を先に外す（段落ごとの理由は syncSection と同じ）
    for (const [key, sec] of existing) {
      if (!usedKeys.has(key)) sec.remove();
    }
    let cursor = body.firstChild;
    for (const section of shown) {
      const key = keyOf(section);
      let sec = existing.get(key);
      if (!sec) sec = el('section', 'c2md-section');
      this.syncSection(sec, section, level, polished);
      // 已在正确位置就零 DOM 操作；分节顺序只增不变，正常路径不搬任何节点
      if (sec === cursor) cursor = cursor.nextSibling;
      else body.insertBefore(sec, cursor);
    }
    return body;
  }

  /** 分节内对账：标题、帧图片（按时刻插在对应段落前）、段落（只增不搬）。 */
  syncSection(sec, section, level, polished) {
    sec.dataset.t = String(section.t ?? section.segments[0]?.start ?? 0);

    let title = sec.querySelector('.c2md-section-title');
    if (section.title) {
      if (!title) {
        title = el('h3', 'c2md-section-title');
        sec.prepend(title);
      }
      if (title.textContent !== section.title) title.textContent = section.title;
    } else if (title) {
      title.remove();
      title = null;
    }

    // 期望的子节点序列：取到图的帧按时刻插在首个 start >= t 的段落前
    const frames = (level === 'none' ? [] : (section.frames ?? [])).filter((frame) => frame.image);
    const items = [];
    let fi = 0;
    for (const seg of section.segments) {
      while (fi < frames.length && frames[fi].t <= seg.start) items.push({ kind: 'frame', frame: frames[fi++] });
      if (seg.raw ?? seg.text) items.push({ kind: 'para', seg });
    }
    while (fi < frames.length) items.push({ kind: 'frame', frame: frames[fi++] });

    const keyOf = (item) => item.kind === 'frame' ? `f${item.frame.t}` : `p${item.seg.id}`;
    const used = new Set(items.map(keyOf));
    // 不要になった子（密度切り替えで外れた図など）は走査の前に外す。残る節点の相対順序は
    // もともと正しいので、以降は新しい節点の挿入だけで済み、段落を一つも動かさない。
    // 後から外すと、居残った図の前へ後続の段落がすべて insertBefore で差し直され、
    // ブラウザのスクロールアンカーが失われて読んでいる位置が図一枚分跳ぶ。
    const existing = new Map();
    for (const child of [...sec.children]) {
      if (child === title) continue;
      const key = child.classList.contains('c2md-frame') ? `f${child.dataset.t}` : `p${child.dataset.id}`;
      if (!existing.has(key) && used.has(key)) existing.set(key, child);
      else child.remove();
    }

    let cursor = title ? title.nextSibling : sec.firstChild;
    for (const item of items) {
      const key = keyOf(item);
      let node = existing.get(key);
      if (item.kind === 'frame') {
        if (!node) node = this.buildFrame(item.frame);
      } else if (node) {
        this.syncPara(node, item.seg, polished);
      } else {
        node = this.buildPara(item.seg, polished);
      }
      // 已在正确位置就零 DOM 操作——段落一旦被 insertBefore 挪动，
      // 原生滚动锚定的锚点就会失联，阅读位置随之漂移
      if (node === cursor) cursor = cursor.nextSibling;
      else sec.insertBefore(node, cursor);
    }
  }

  /** 就地更新段落：状态、显隐、文本，有变化才动 DOM。 */
  syncPara(node, seg, polished) {
    const raw = seg.raw ?? seg.text;
    const say = node.querySelector('.c2md-say');
    // 摘掉残留的润色脉冲：动画类跟着节点重放就是深绿闪
    if (say.classList.contains('c2md-say--fresh')) say.classList.remove('c2md-say--fresh');
    const state = seg.state ?? 'kept';
    if (node.dataset.state !== state) node.dataset.state = state;
    const display = polished && seg.state === 'skipped' ? 'none' : '';
    if (node.style.display !== display) node.style.display = display;
    if (say.dataset.raw !== raw) say.dataset.raw = raw;
    if (seg.raw && seg.text && seg.raw !== seg.text) {
      if (say.dataset.polished !== seg.text) say.dataset.polished = seg.text;
    } else if (say.dataset.polished !== undefined) {
      delete say.dataset.polished;
    }
    const target = polished && say.dataset.polished ? say.dataset.polished : say.dataset.raw;
    if (say.textContent !== target) say.textContent = target;
  }

  buildFrame(frame) {
    const figure = el('figure', 'c2md-frame');
    figure.dataset.t = String(frame.t);
    const image = document.createElement('img');
    image.src = frame.image;
    image.alt = `视频画面 ${fmtTs(frame.t)}`;
    image.loading = 'lazy';
    figure.appendChild(image);
    return figure;
  }

  buildPara(seg, polished) {
    const raw = seg.raw ?? seg.text;
    const shown = polished ? seg.text : raw;
    const p = el('p', 'c2md-para');
    p.dataset.id = String(seg.id);
    p.dataset.state = seg.state ?? 'kept';
    p.style.display = polished && seg.state === 'skipped' ? 'none' : '';
    p.dataset.start = String(seg.start);

    const sec0 = Number(seg.start);
    const stamp = document.createElement('button');
    stamp.type = 'button';
    stamp.className = 'c2md-ts c2md-num';
    stamp.dataset.start = String(sec0);
    stamp.textContent = fmtTs(sec0);
    stamp.title = `跳转到 ${fmtTs(sec0)}`;
    stamp.addEventListener('click', () => this.panel.handlers.onSeek?.(sec0));
    p.appendChild(stamp);

    const say = el('span', 'c2md-say');
    say.dataset.raw = raw;
    if (seg.raw && seg.text && seg.raw !== seg.text) say.dataset.polished = seg.text;
    say.textContent = shown;
    p.appendChild(say);
    return p;
  }
}
