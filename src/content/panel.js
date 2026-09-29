//! 页面内面板：标题、三个勾选、状态、正文、导出。
//!
//! 正文里的每个段落元素同时带着原文与润色文（data-raw / data-polished），
//! 切换「润色文本」只是换 textContent，不重建 DOM——所以切换是瞬时的、
//! 不会跳滚动位置，也不需要为了看一眼原文再请求一次 LLM。

import { fmtTs } from '../core/time.js';
import { displayToggleRows, iconButton, note, progress, progressRing } from '../ui/controls.js';

export class Panel {
  /**
   * @param {object} handlers
   * @param {(patch:object) => void} handlers.onSettings
   * @param {(seconds:number) => void} handlers.onSeek
   * @param {'copy'|'copyText'|'download'|'rerun'|'repolish'|'options'|'close'|'switchToAsr'} handlers …各动作
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.state = { status: 'idle', settings: null, meta: null, sections: [], stats: null, warnings: [], error: null, polish: null };
    this.host = null;
    this.scope = null;
    this.bodyEl = null;
    this.warnedOnce = new Set();
    this.layout = null;
  }

  /** 挂到页面上。已挂则复用。 */
  mount() {
    if (this.host?.isConnected) return;
    const host = document.createElement('div');
    host.id = 'c2md-panel-host';
    this.host = host;
    if (this.layout?.docked) host.dataset.docked = 'true';
    else if (this.layout) {
      host.style.left = `${this.layout.left}px`;
      host.style.top = `${this.layout.top}px`;
      host.style.right = 'auto';
      host.style.width = `${this.layout.width}px`;
      host.style.height = `${this.layout.height}px`;
    }
    // 立刻挂载，避免页面 SPA 路由把我们的节点清掉后找不到
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    this.applyStyles(root);

    this.scope = document.createElement('div');
    this.scope.className = 'c2md-scope';
    root.appendChild(this.scope);
    this.render();
  }

  unmount() {
    if (this.host?.isConnected) this.rememberLayout();
    this.host?.remove();
    this.host = null;
    this.scope = null;
    this.bodyEl = null;
  }

  rememberLayout() {
    const rect = this.host.getBoundingClientRect();
    this.layout = this.host.dataset.docked === 'true'
      ? { ...this.layout, docked: true }
      : { docked: false, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  startDrag(event) {
    if (event.button !== 0 || event.target.closest('button')) return;
    const host = this.host;
    const rect = host.getBoundingClientRect();
    const origin = { x: event.clientX, y: event.clientY };
    const docked = host.dataset.docked === 'true';
    let moved = false;
    const move = (e) => {
      if (!moved && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 4) return;
      if (!moved && docked) {
        host.dataset.docked = 'false';
        host.style.width = `${this.layout?.width || 420}px`;
        host.style.height = `${this.layout?.height || Math.min(innerHeight * 0.76, 780)}px`;
      }
      moved = true;
      const width = host.getBoundingClientRect().width;
      const height = host.getBoundingClientRect().height;
      const left = docked
        ? e.clientX - Math.min(event.clientX - rect.left, width - 24)
        : rect.left + e.clientX - origin.x;
      host.style.left = `${Math.max(0, Math.min(innerWidth - width, left))}px`;
      host.style.top = `${Math.max(0, Math.min(innerHeight - height, rect.top + e.clientY - origin.y))}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      if (!moved) return;
      this.rememberLayout();
      if (host.getBoundingClientRect().right >= innerWidth - 24) {
        host.dataset.docked = 'true';
        host.style.cssText = '';
        this.layout.docked = true;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  }

  get isMounted() {
    return Boolean(this.host?.isConnected);
  }

  /** 样式表用扩展内的文件，不把 CSS 复制进 JS 字符串。 */
  applyStyles(root) {
    const base = document.createElement('link');
    base.rel = 'stylesheet';
    base.href = chrome.runtime.getURL('src/ui/tokens.css');
    const panel = document.createElement('link');
    panel.rel = 'stylesheet';
    panel.href = chrome.runtime.getURL('src/ui/panel.css');
    root.append(base, panel);
  }

  /** 合并状态并重绘。只有影响结构的字段才触发重建。 */
  setState(patch) {
    const progressOnly = this.state.status === 'running' && patch.status === 'running' &&
      Object.keys(patch).every((key) => key === 'status' || key === 'stageLabel' || key === 'stageRatio');
    const polishOnly = this.state.polish?.running && patch.polish?.running && Object.keys(patch).length === 1;
    const needsRebuild =
      'status' in patch ||
      'sections' in patch ||
      'meta' in patch ||
      'stats' in patch ||
      'error' in patch ||
      'polish' in patch ||
      'imagesPending' in patch ||
      'warnings' in patch;
    const displayChanged = 'settings' in patch && patch.settings?.imageLevel !== this.state.settings?.imageLevel;

    Object.assign(this.state, patch);

    if (!this.scope) return;
    if (progressOnly) {
      const ring = this.scope.querySelector('.c2md-source .c2md-ring');
      if (Boolean(ring) !== Number.isFinite(this.state.stageRatio)) {
        this.render();
        return;
      }
      if (ring && Number.isFinite(this.state.stageRatio)) {
        const now = Math.round(this.state.stageRatio * 100);
        ring.style.setProperty('--progress', `${now}%`);
        ring.title = `转写 ${now}%`;
        ring.setAttribute('aria-valuenow', String(now));
      }
      return;
    }
    if (polishOnly) {
      const ring = this.scope.querySelector('.c2md-panel-toggles .c2md-ring');
      if (ring) {
        const { done, total } = this.state.polish;
        ring.style.setProperty('--progress', `${total > 0 ? Math.min(100, 100 * done / total) : 0}%`);
        ring.title = total > 0 ? `润色 ${done}/${total}` : '正在准备润色';
        if (total > 0) {
          ring.setAttribute('aria-valuemax', String(total));
          ring.setAttribute('aria-valuenow', String(done));
        }
      }
      return;
    }
    if (needsRebuild || displayChanged) this.render();
    // 勾选的显隐永远只是切属性，不重建
    this.applyDisplayMode();
  }

  /** 依据设置切换显隐与文本版本，不碰 DOM 结构。 */
  applyDisplayMode() {
    const { settings } = this.state;
    if (!this.scope || !settings) return;

    this.scope.dataset.timestamps = settings.showTimestamps ? 'on' : 'off';
    this.scope.dataset.theme = settings.theme ?? 'auto';

    const polished = Boolean(settings.polish && this.state.polish?.hasResult);
    for (const el of this.scope.querySelectorAll('.c2md-say')) {
      const next = polished && el.dataset.polished ? el.dataset.polished : el.dataset.raw;
      if (el.textContent !== next) {
        el.textContent = next;
        if (polished && el.dataset.polished) {
          el.classList.remove('c2md-say--fresh');
          void el.offsetWidth;
          el.classList.add('c2md-say--fresh');
          // 脉冲放完就摘类：残留的完成态动画一旦节点被移动可能重放（深绿闪）
          el.addEventListener('animationend', () => el.classList.remove('c2md-say--fresh'), { once: true });
        }
      }
    }
    for (const section of this.scope.querySelectorAll('.c2md-section')) {
      let visible = false;
      for (const para of section.querySelectorAll('.c2md-para')) {
        para.style.display = polished && para.dataset.state === 'skipped' ? 'none' : '';
        if (para.style.display !== 'none') visible = true;
      }
      section.style.display = visible ? '' : 'none';
    }
  }

  updateSegment(seg) {
    const p = this.scope?.querySelector(`.c2md-para[data-id="${seg.id}"]`);
    if (!p) return;
    const say = p.querySelector('.c2md-say');
    say.dataset.raw = seg.raw ?? seg.text;
    if (seg.raw && seg.text && seg.raw !== seg.text) say.dataset.polished = seg.text;
    else delete say.dataset.polished;
    p.dataset.state = seg.state ?? 'kept';
    const polished = this.state.settings?.polish;
    p.style.display = polished && seg.state === 'skipped' ? 'none' : '';
    const next = polished && say.dataset.polished ? say.dataset.polished : say.dataset.raw;
    if (say.textContent !== next) {
      say.textContent = next;
      if (polished) {
        say.classList.remove('c2md-say--fresh');
        void say.offsetWidth;
        say.classList.add('c2md-say--fresh');
        // 脉冲放完就摘类，避免残留动画随后续重排重放
        say.addEventListener('animationend', () => say.classList.remove('c2md-say--fresh'), { once: true });
      }
    }
  }

  render() {
    if (!this.scope) return;
    // 更新前先记录视口锚点：用户正读到的段落。图片插入/移除、密度切换、
    // 新文段到达都会改变排版，锚定保证「正在阅读的那段字」停在原视口位置。
    const anchor = this.captureAnchor();

    const reuseToggles = this.controlsSettings === this.state.settings &&
      this.controlsPolishRunning === Boolean(this.state.polish?.running);
    const toggles = reuseToggles ? this.scope.querySelector('.c2md-panel-toggles') : null;
    this.controlsSettings = this.state.settings;
    this.controlsPolishRunning = Boolean(this.state.polish?.running);

    // 槽位同步：正文原地更新（绝不脱离文档），头部/状态/底部按槽位替换兄弟节点。
    // 此前用 replaceChildren 整体重挂，正文连根拔起——脱离文档瞬间 scrollTop
    // 被清零，滚轮手势也会被打断，这就是图片到达时短暂滚不动、阅读位置漂移的根源。
    const slots = [
      this.renderHead(),
      toggles ?? this.renderToggles(),
      this.renderStatus(),
      this.renderBody(),
      this.renderFoot(),
    ];
    const current = [...this.scope.children];
    slots.forEach((node, index) => {
      if (current[index] === node) return;
      if (current[index]) current[index].replaceWith(node);
      else this.scope.append(node);
    });
    for (const extra of current.slice(slots.length)) extra.remove();

    this.restoreAnchor(anchor);
    this.applyDisplayMode();
  }

  /**
   * 记录视口顶缘第一个可见段落及其在视口内的偏移。
   * 只在已滚动时生效：滚到顶时新图片应当自然出现在眼前、内容自然下推，
   * 这时不加补偿，绝不自己滚动。
   */
  captureAnchor() {
    const body = this.bodyEl;
    if (!body?.isConnected || body.scrollTop <= 0) return null;
    const bodyTop = body.getBoundingClientRect().top;
    for (const p of body.querySelectorAll('.c2md-para')) {
      const rect = p.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > bodyTop) {
        return { id: p.dataset.id, offset: rect.top - bodyTop };
      }
    }
    return null;
  }

  /** 把锚定段落放回更新前的视口位置；锚不在了（被隐藏/移除）就维持现状。 */
  restoreAnchor(anchor) {
    if (!anchor) return;
    const body = this.bodyEl;
    const p = body?.querySelector(`.c2md-para[data-id="${anchor.id}"]`);
    if (!p) return;
    const rect = p.getBoundingClientRect();
    if (rect.height <= 0) return;
    const delta = rect.top - body.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 1) body.scrollTop += delta;
  }

  // ---------- 头部 ----------
  renderHead() {
    const { meta, status } = this.state;
    const head = el('div', 'c2md-panel-head');
    head.addEventListener('pointerdown', (event) => this.startDrag(event));

    const top = el('div', 'c2md-head-top');
    const title = el('div', 'c2md-title');
    title.textContent = meta?.title || 'course2md';
    title.title = meta?.title ?? '';
    top.appendChild(title);

    const actions = el('div', 'c2md-head-actions');
    actions.append(
      iconButton({ iconName: 'refresh', label: '重新生成', onClick: () => this.handlers.onRerun?.() }),
      iconButton({ iconName: 'settings', label: '设置', onClick: () => this.handlers.onOptions?.() }),
      iconButton({ iconName: 'close', label: '收起面板', onClick: () => this.handlers.onClose?.() }),
    );
    top.appendChild(actions);
    head.appendChild(top);

    const line = el('div', 'c2md-source');
    if (meta?.duration) line.appendChild(plain(fmtTs(meta.duration)));
    if (status === 'running' && Number.isFinite(this.state.stageRatio)) {
      line.appendChild(progressRing(Math.round(this.state.stageRatio * 100), 100, '转写'));
    }
    if (line.childNodes.length) head.appendChild(line);
    return head;
  }

  // ---------- 勾选 ----------
  renderToggles() {
    const wrap = el('div', 'c2md-panel-toggles');
    const settings = this.state.settings;
    if (!settings) return wrap;
    wrap.appendChild(
      displayToggleRows({
        settings,
        onChange: (patch) => this.handlers.onSettings?.(patch),
        onSetup: () => this.handlers.onOptions?.('llm'),
        polishProgress: this.state.polish,
      }),
    );
    return wrap;
  }

  // ---------- 状态 ----------
  renderStatus() {
    const wrap = el('div', 'c2md-panel-status');
    const { error, warnings } = this.state;
    if (error) {
      const actions = [];
      if (error.switchToAsr) {
        actions.push(
          button('改用本地模型转录', () => this.handlers.onSwitchToAsr?.(), 'primary'),
        );
      }
      if (error.options) {
        actions.push(button('打开设置', () => this.handlers.onOptions?.(error.options)));
      }
      wrap.appendChild(
        note({ title: error.title, body: error.body, tone: 'error', actions }),
      );
    }

    const pending = (warnings ?? []).filter(Boolean);
    for (const text of pending) {
      // 同一个提醒不重复堆叠
      const key = String(text).slice(0, 40);
      if (this.warnedOnce.has(key)) continue;
      this.warnedOnce.add(key);
      const line = el('div', 'c2md-meta');
      line.textContent = String(text);
      wrap.appendChild(line);
    }
    return wrap;
  }

  // ---------- 正文 ----------
  renderBody() {
    // 滚动容器复用同一个节点，不随重建更换：换节点会打断进行中的滚轮手势
    // （图片批量到达时正好滚一半就被锁住）。
    // 内容按段落 reconcile：已有段落原节点就地更新（文本节点不重建，锚定才有
    // 依靠），新段落追加、消失的移除，只有图片和标题是全新节点。
    const body = this.bodyEl?.isConnected ? this.bodyEl : el('div', 'c2md-panel-body');
    this.bodyEl = body;
    const { status, sections, settings } = this.state;

    if ((status === 'loading' || status === 'running') && !sections?.length) {
      if (!body.querySelector('.c2md-empty')) {
        const empty = el('div', 'c2md-empty');
        empty.appendChild(progress({ ratio: null, label: '正在取文字' }));
        body.replaceChildren(empty);
      }
      return body;
    }
    if (!sections?.length) {
      if (status !== 'error' && !body.querySelector('.c2md-empty')) {
        const empty = el('div', 'c2md-empty');
        empty.textContent = '暂无笔记';
        body.replaceChildren(empty);
      }
      return body;
    }

    const reusable = new Map();
    for (const p of body.querySelectorAll('.c2md-para')) reusable.set(p.dataset.id, p);
    const reused = new Set();
    const next = el('div');
    const polished = Boolean(settings?.polish && this.state.polish?.hasResult);

    for (const section of sections) {
      if (!section.segments.some((seg) => seg.raw ?? seg.text)) continue;
      const sec = el('section', 'c2md-section');
      if (settings?.imageLevel !== 'none') {
        // 有图没图都渲染同一个恒定尺寸的框：切挡时版面即刻是最终形态，
        // 图片到达只是填框（异步解码不改变高度），文本不会被顶来顶去
        const figure = el('figure', 'c2md-frame');
        if (section.image) {
          const image = document.createElement('img');
          image.src = section.image;
          image.alt = `视频画面 ${fmtTs(section.t)}`;
          image.loading = 'lazy';
          figure.appendChild(image);
        }
        sec.appendChild(figure);
      }
      if (section.title) {
        const h = el('h3', 'c2md-section-title');
        h.textContent = section.title;
        sec.appendChild(h);
      }

      for (const seg of section.segments) {
        const raw = seg.raw ?? seg.text;
        const shown = polished ? seg.text : raw;
        if (!shown && !raw) continue;
        const id = String(seg.id);
        const existing = !reused.has(id) ? reusable.get(id) : undefined;
        reused.add(id);
        if (existing) {
          // 就地更新：状态、显隐、文本，有变化才动 DOM，避免无谓的布局抖动
          const say = existing.querySelector('.c2md-say');
          // 段落要在小节间挪窝：摘掉残留的润色脉冲，别让旧动画跟着重放
          say.classList.remove('c2md-say--fresh');
          const state = seg.state ?? 'kept';
          if (existing.dataset.state !== state) existing.dataset.state = state;
          const display = polished && seg.state === 'skipped' ? 'none' : '';
          if (existing.style.display !== display) existing.style.display = display;
          if (say.dataset.raw !== raw) say.dataset.raw = raw;
          if (seg.raw && seg.text && seg.raw !== seg.text) {
            if (say.dataset.polished !== seg.text) say.dataset.polished = seg.text;
          } else if (say.dataset.polished !== undefined) {
            delete say.dataset.polished;
          }
          const target = polished && say.dataset.polished ? say.dataset.polished : say.dataset.raw;
          if (say.textContent !== target) say.textContent = target;
          sec.append(existing);
        } else {
          sec.append(this.buildPara(seg, polished));
        }
      }
      next.append(sec);
    }

    // 先加新、后删旧：滚动高度不经历塌陷，浏览器不需要中途钳位
    const stale = [...body.childNodes];
    body.append(...next.childNodes);
    for (const node of stale) node.remove();
    return body;
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
    stamp.addEventListener('click', () => this.handlers.onSeek?.(sec0));
    p.appendChild(stamp);

    const say = el('span', 'c2md-say');
    say.dataset.raw = raw;
    if (seg.raw && seg.text && seg.raw !== seg.text) say.dataset.polished = seg.text;
    say.textContent = shown;
    p.appendChild(say);
    return p;
  }

  // ---------- 底部 ----------
  renderFoot() {
    const foot = el('div', 'c2md-panel-foot');
    const { status, settings } = this.state;
    const ready = status === 'ready';
    const exportReady = ready && (!this.state.imagesPending || settings?.imageLevel === 'none');

    const copy = button('复制 Markdown', () => this.handlers.onCopy?.(), 'primary');
    copy.disabled = !exportReady;
    const save = button(settings?.imageLevel === 'none' ? '保存文字 .md' : '下载图文 .md', () => this.handlers.onDownload?.());
    save.disabled = !exportReady;

    foot.append(copy, save);

    const spacer = el('div', 'c2md-actions-spacer');
    foot.appendChild(spacer);

    const copyText = iconButton({
      iconName: 'copy',
      label: '复制纯文本',
      onClick: () => this.handlers.onCopyText?.(),
    });
    copyText.disabled = !ready && !(status === 'running' && this.state.sections?.some((section) =>
      section.segments.some((seg) => seg.raw ?? seg.text)));
    foot.appendChild(copyText);

    return foot;
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(label, onClick, variant) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `c2md-button${variant ? ` c2md-button--${variant}` : ''}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function plain(text) {
  const span = document.createElement('span');
  span.className = 'c2md-num';
  span.textContent = text ?? '';
  return span;
}
