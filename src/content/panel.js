//! 页面内面板：标题、三个勾选、状态、正文、导出。
//!
//! 正文里的每个段落元素同时带着原文与润色文（data-raw / data-polished），
//! 切换「润色文本」只是换 textContent，不重建 DOM——所以切换是瞬时的、
//! 不会跳滚动位置，也不需要为了看一眼原文再请求一次 LLM。

import { fmtTs } from '../core/time.js';
import { displayToggleRows, iconButton, note, progressRing } from '../ui/controls.js';
import { PanelBody } from './panel-body.js';
import { all, button, el, one, plain } from './panel-dom.js';

/**
 * 面板显示所需的状态。控制器的 panelState() 给全量，setState 可以只给变了的字段。
 * @typedef {object} PanelState
 * @property {import('./content.js').Status} status
 * @property {import('../core/settings.js').Settings|null} settings
 * @property {{title?: string, duration?: number}|null} meta
 * @property {import('../core/format.js').DocSection[]} sections
 * @property {import('./pipeline.js').PipelineStats|null} stats
 * @property {string[]} warnings
 * @property {import('./errors.js').ErrorState|null} error
 * @property {import('./polish-coordinator.js').PolishProgress|null} polish
 * @property {string} [stageLabel]
 * @property {number|null} [stageRatio] 转写进度 0–1；不知道时为 null
 * @property {boolean} [imagesPending]
 * @property {boolean} [exportReady]
 * @property {boolean} [exportBusy]
 * @property {Record<'copy'|'download', boolean>} [pendingExport]
 * @property {Record<'copy'|'download', boolean>} [exportFlash]
 */

/** @typedef {{docked: boolean, left?: number, top?: number, width?: number, height?: number}} Layout 用户拖过的位置与大小（停靠时沿用停靠前的大小） */

export class Panel {
  /**
   * @param {object} handlers
   * @param {(patch:object) => unknown} handlers.onSettings
   * @param {(seconds:number) => unknown} handlers.onSeek
   * @param {() => unknown} [handlers.onCopy]
   * @param {() => unknown} [handlers.onCopyText]
   * @param {() => unknown} [handlers.onDownload]
   * @param {() => unknown} [handlers.onLibrary]
   * @param {() => unknown} [handlers.onRerun]
   * @param {() => unknown} [handlers.onRepolish]
   * @param {(section?:string) => unknown} [handlers.onOptions]
   * @param {() => unknown} [handlers.onClose]
   */
  constructor(handlers) {
    this.handlers = handlers;
    /** @type {PanelState} */
    this.state = { status: 'idle', settings: null, meta: null, sections: [], stats: null, warnings: [], error: null, polish: null };
    /** @type {HTMLDivElement|null} */
    this.host = null;
    /** @type {HTMLDivElement|null} */
    this.scope = null;
    this.body = new PanelBody(this);
    /** @type {Layout|null} */
    this.layout = null;
    /** 上次画勾选区时的设置与润色状态：两者都没变就复用那块 DOM（见 render） */
    /** @type {PanelState['settings']|undefined} */
    this.controlsSettings = undefined;
    this.controlsPolishRunning = false;
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
    this.body.el = null;
  }

  rememberLayout() {
    if (!this.host) return;
    const rect = this.host.getBoundingClientRect();
    this.layout = this.host.dataset.docked === 'true'
      ? { ...this.layout, docked: true }
      : { docked: false, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  /** @param {PointerEvent} event */
  startDrag(event) {
    const host = this.host;
    if (!host || event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
    const rect = host.getBoundingClientRect();
    const origin = { x: event.clientX, y: event.clientY };
    const docked = host.dataset.docked === 'true';
    let moved = false;
    const move = (/** @type {PointerEvent} */ e) => {
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
        if (this.layout) this.layout.docked = true;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  }

  get isMounted() {
    return Boolean(this.host?.isConnected);
  }

  /**
   * 样式表用扩展内的文件，不把 CSS 复制进 JS 字符串。
   * @param {ShadowRoot} root
   */
  applyStyles(root) {
    const base = document.createElement('link');
    base.rel = 'stylesheet';
    base.href = chrome.runtime.getURL('src/ui/tokens.css');
    const panel = document.createElement('link');
    panel.rel = 'stylesheet';
    panel.href = chrome.runtime.getURL('src/ui/panel.css');
    root.append(base, panel);
  }

  /**
   * 合并状态并重绘。只有影响结构的字段才触发重建。
   * @param {Partial<PanelState>} patch
   */
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
      'warnings' in patch ||
      ['exportReady', 'exportBusy', 'pendingExport', 'exportFlash'].some((key) => key in patch);
    const displayChanged = 'settings' in patch && patch.settings?.imageLevel !== this.state.settings?.imageLevel;

    Object.assign(this.state, patch);

    if (!this.scope) return;
    if (progressOnly) {
      const ring = one(this.scope, '.c2md-source .c2md-ring');
      const ratio = this.state.stageRatio;
      const known = typeof ratio === 'number' && Number.isFinite(ratio);
      if (Boolean(ring) !== known) {
        this.render();
        return;
      }
      if (ring && known) {
        const now = Math.round(ratio * 100);
        ring.style.setProperty('--progress', `${now}%`);
        ring.title = `转写 ${now}%`;
        ring.setAttribute('aria-valuenow', String(now));
      }
      return;
    }
    if (polishOnly) {
      const ring = one(this.scope, '.c2md-panel-toggles .c2md-ring');
      if (ring && this.state.polish) {
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
    for (const el of all(this.scope, '.c2md-say')) {
      const next = (polished && el.dataset.polished ? el.dataset.polished : el.dataset.raw) ?? '';
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
    for (const section of all(this.scope, '.c2md-section')) {
      let visible = false;
      for (const para of all(section, '.c2md-para')) {
        para.style.display = polished && para.dataset.state === 'skipped' ? 'none' : '';
        if (para.style.display !== 'none') visible = true;
      }
      section.style.display = visible ? '' : 'none';
    }
  }

  /**
   * 润色写回了一个段落：只改这一段的文字与状态。
   * @param {import('../core/model.js').Segment} seg
   */
  updateSegment(seg) {
    const p = one(this.scope, `.c2md-para[data-id="${seg.id}"]`);
    const say = one(p, '.c2md-say');
    if (!p || !say) return;
    say.dataset.raw = seg.raw ?? seg.text;
    if (seg.raw && seg.text && seg.raw !== seg.text) say.dataset.polished = seg.text;
    else delete say.dataset.polished;
    p.dataset.state = seg.state ?? 'kept';
    const polished = this.state.settings?.polish;
    p.style.display = polished && seg.state === 'skipped' ? 'none' : '';
    const next = (polished && say.dataset.polished ? say.dataset.polished : say.dataset.raw) ?? '';
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
    const scope = this.scope;
    if (!scope) return;

    const reuseToggles = this.controlsSettings === this.state.settings &&
      this.controlsPolishRunning === Boolean(this.state.polish?.running);
    const toggles = reuseToggles ? scope.querySelector('.c2md-panel-toggles') : null;
    this.controlsSettings = this.state.settings;
    this.controlsPolishRunning = Boolean(this.state.polish?.running);

    // 槽位同步：正文原地更新（绝不脱离文档），头部/状态/底部按槽位替换兄弟节点。
    // 此前用 replaceChildren 整体重挂，正文连根拔起——脱离文档瞬间 scrollTop
    // 被清零，滚轮手势也会被打断，这就是图片到达时短暂滚不动、阅读位置漂移的根源。
    // 图片增删时的阅读位置由浏览器原生滚动锚定兜住（.c2md-panel-body 开
    // overflow-anchor，图片框声明 overflow-anchor:none 退出锚点候选），
    // 前提是锚点——段落节点——跨更新存活，renderBody 的对账保证了这一点。
    const slots = [
      this.renderHead(),
      toggles ?? this.renderToggles(),
      this.renderStatus(),
      this.body.render(),
      this.renderFoot(),
    ];
    const current = [...scope.children];
    slots.forEach((node, index) => {
      if (current[index] === node) return;
      if (current[index]) current[index].replaceWith(node);
      else scope.append(node);
    });
    for (const extra of current.slice(slots.length)) extra.remove();

    this.applyDisplayMode();
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
    const ratio = this.state.stageRatio;
    if (status === 'running' && typeof ratio === 'number' && Number.isFinite(ratio)) {
      line.appendChild(progressRing(Math.round(ratio * 100), 100, '转写'));
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
      if (error.options) {
        actions.push(button('打开设置', () => this.handlers.onOptions?.(error.options)));
      }
      wrap.appendChild(
        note({ title: error.title, body: error.body, tone: 'error', actions }),
      );
    }

    const pending = (warnings ?? []).filter(Boolean);
    // 同じ提醒は一度の描画の中でだけ重複を除く。描画をまたいで記憶すると、提醒は
    // 最初の描画にしか出ず、次の再描画（進捗や図の到着）で消えてしまう
    const shown = new Set();
    for (const text of pending) {
      const key = String(text).slice(0, 40);
      if (shown.has(key)) continue;
      shown.add(key);
      const line = el('div', 'c2md-meta');
      line.textContent = String(text);
      wrap.appendChild(line);
    }
    return wrap;
  }

  // ---------- 底部 ----------
  renderFoot() {
    const foot = el('div', 'c2md-panel-foot');
    const { status, settings } = this.state;
    const ready = status === 'ready';
    const copy = this.exportButton('copy', {
      idle: '复制 Markdown', pending: '完成后复制', done: '已复制', variant: 'primary',
      onClick: () => this.handlers.onCopy?.(),
    });
    const save = this.exportButton('download', {
      idle: settings?.imageLevel === 'none' ? '保存文字 .md' : '下载图文 .md', pending: '完成后下载', done: '已保存',
      onClick: () => this.handlers.onDownload?.(),
    });

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
    if (this.handlers.onLibrary) {
      const library = iconButton({ iconName: 'open', label: '存入课程库', onClick: () => this.handlers.onLibrary?.() });
      library.disabled = !ready || this.state.exportBusy || !this.state.exportReady;
      foot.appendChild(library);
    }

    return foot;
  }

  /**
   * 書き出しボタン。作成中でも押せて、押すと「完了後に実行」の予約になる（破線枠で示し、
   * もう一度押すと取り消し）。完了した瞬間に自動で実行し、結果をしばらく表示する。
   * @param {'copy'|'download'} kind
   * @param {{ idle: string, pending: string, done: string, variant?: string, onClick: () => void }} labels
   */
  exportButton(kind, { idle, pending, done, variant, onClick }) {
    const { status, settings, exportBusy, pendingExport, exportFlash } = this.state;
    const exportReady = this.state.exportReady ??
      (status === 'ready' && (!this.state.imagesPending || settings?.imageLevel === 'none'));
    const armed = Boolean(pendingExport?.[kind]);
    const active = exportFlash?.[kind] ? done : armed ? pending : idle;
    const node = button('', onClick, variant);
    // 三种文字叠在同一格里、只显示当前那个：按钮宽度始终取最宽的一种，切换时尺寸不变
    const labels = el('span', 'c2md-button-labels');
    for (const text of new Set([idle, pending, done])) {
      const label = el('span');
      label.textContent = text;
      if (text !== active) label.setAttribute('aria-hidden', 'true');
      labels.appendChild(label);
    }
    node.appendChild(labels);
    node.dataset.label = active;
    node.disabled = !exportReady && !exportBusy;
    if (exportReady) return node;
    if (armed) {
      node.classList.add('c2md-button--armed');
      node.setAttribute('aria-pressed', 'true');
      node.title = '生成完成后自动执行；再点一次取消';
    } else if (exportBusy) {
      node.setAttribute('aria-pressed', 'false');
      node.title = '还在生成：点一下，完成后自动执行';
    }
    return node;
  }
}
