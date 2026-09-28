//! 页面内面板：标题、三个勾选、状态、正文、导出。
//!
//! 正文里的每个段落元素同时带着原文与润色文（data-raw / data-polished），
//! 切换「润色文本」只是换 textContent，不重建 DOM——所以切换是瞬时的、
//! 不会跳滚动位置，也不需要为了看一眼原文再请求一次 LLM。

import { fmtTs } from '../core/time.js';
import { icon } from '../ui/icons.js';
import { displayToggleRows, iconButton, note, progress } from '../ui/controls.js';
import { sourceLabel } from '../core/format.js';

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
  }

  /** 挂到页面上。已挂则复用。 */
  mount() {
    if (this.host?.isConnected) return;
    const host = document.createElement('div');
    host.id = 'c2md-panel-host';
    this.host = host;
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
    this.host?.remove();
    this.host = null;
    this.scope = null;
    this.bodyEl = null;
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
    const needsRebuild =
      'status' in patch ||
      'sections' in patch ||
      'meta' in patch ||
      'stats' in patch ||
      'error' in patch ||
      'polish' in patch ||
      'warnings' in patch;

    Object.assign(this.state, patch);

    if (!this.scope) return;
    if (needsRebuild) this.render();
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
      if (el.textContent !== next) el.textContent = next;
    }
    for (const ts of this.scope.querySelectorAll('.c2md-ts')) {
      const sec = Number(ts.dataset.start);
      if (!Number.isFinite(sec)) continue;
      const clickable = Boolean(settings.clickToSeek && settings.showTimestamps);
      // 可点击时是真按钮，不可点击时是纯文本——不要给不可用的东西按钮语义
      if (clickable && ts.tagName !== 'BUTTON') {
        this.replaceWithButton(ts, sec);
      } else if (!clickable && ts.tagName === 'BUTTON') {
        this.replaceWithSpan(ts, sec);
      }
    }
  }

  replaceWithButton(el, sec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'c2md-ts c2md-num';
    button.dataset.start = String(sec);
    button.textContent = el.textContent;
    button.title = `跳转到 ${fmtTs(sec)}`;
    button.addEventListener('click', () => this.handlers.onSeek?.(sec));
    el.replaceWith(button);
  }

  replaceWithSpan(el, sec) {
    const span = document.createElement('span');
    span.className = 'c2md-ts c2md-num';
    span.dataset.start = String(sec);
    span.textContent = el.textContent;
    el.replaceWith(span);
  }

  render() {
    if (!this.scope) return;
    const scrollTop = this.bodyEl?.scrollTop ?? 0;

    this.scope.replaceChildren(
      this.renderHead(),
      this.renderToggles(),
      this.renderStatus(),
      this.renderBody(),
      this.renderFoot(),
    );
    this.applyDisplayMode();

    if (this.bodyEl && scrollTop) this.bodyEl.scrollTop = scrollTop;
  }

  // ---------- 头部 ----------
  renderHead() {
    const { meta, stats, status } = this.state;
    const head = el('div', 'c2md-panel-head');

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
    if (status === 'ready' || status === 'running') {
      line.appendChild(chip('text', sourceLabel(stats?.source)));
      if (stats?.trackLabel) line.appendChild(chip('info', stats.trackLabel));
      if (this.countedSegments() !== null) {
        line.appendChild(chip('', `${this.countedSegments()} 段`));
      }
      if (meta?.duration) line.appendChild(plain(fmtTs(meta.duration)));
    }
    head.appendChild(line);
    return head;
  }

  countedSegments() {
    const { sections, settings } = this.state;
    if (!sections?.length) return null;
    const polished = Boolean(settings?.polish && this.state.polish?.hasResult);
    let n = 0;
    for (const section of sections) {
      for (const seg of section.segments) {
        if (seg.state === 'skipped') continue;
        if (!polished && !seg.text) continue;
        n++;
      }
    }
    return n;
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
      }),
    );
    return wrap;
  }

  // ---------- 状态 ----------
  renderStatus() {
    const wrap = el('div', 'c2md-panel-status');
    const { status, error, warnings, polish } = this.state;
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

    if (polish?.running) {
      wrap.appendChild(
        progress({
          ratio: polish.total ? polish.done / polish.total : null,
          label: `正在润色 ${polish.done}/${polish.total} 块`,
        }),
      );
    } else if (polish?.summary) {
      // 一行结果说明就是一行文字。给它套个带边框的卡片，等于给状态加装饰。
      const line = el('div', 'c2md-meta');
      line.textContent = polish.summary;
      wrap.appendChild(line);
    }

    const pending = (warnings ?? []).filter(Boolean);
    for (const text of pending) {
      // 同一个提醒不重复堆叠
      const key = String(text).slice(0, 40);
      if (this.warnedOnce.has(key)) continue;
      this.warnedOnce.add(key);
      wrap.appendChild(note({ body: String(text), tone: 'warn' }));
    }
    return wrap;
  }

  // ---------- 正文 ----------
  renderBody() {
    const body = el('div', 'c2md-panel-body');
    this.bodyEl = body;

    const { status, sections, settings } = this.state;
    if (status === 'loading' || status === 'running') {
      const empty = el('div', 'c2md-empty');
      empty.appendChild(progress({ ratio: null, label: this.state.stageLabel || '正在取文字' }));
      body.appendChild(empty);
      return body;
    }
    if (!sections?.length) {
      if (status !== 'error') {
        const empty = el('div', 'c2md-empty');
        empty.textContent = '还没有内容。在弹窗里点「生成笔记」开始。';
        body.appendChild(empty);
      }
      return body;
    }

    const polished = Boolean(settings?.polish && this.state.polish?.hasResult);

    for (const section of sections) {
      const visible = section.segments.filter(
        (seg) => seg.state !== 'skipped' && (polished ? seg.text : seg.raw ?? seg.text),
      );
      if (!visible.length) continue;

      const sec = el('section', 'c2md-section');
      if (section.image) {
        const figure = el('figure', 'c2md-frame');
        const image = document.createElement('img');
        image.src = section.image;
        image.alt = `视频画面 ${fmtTs(section.t)}`;
        image.loading = 'lazy';
        figure.appendChild(image);
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
        if (seg.state === 'skipped' || !shown) continue;

        const p = el('p', 'c2md-para');
        p.dataset.state = seg.state ?? 'kept';
        p.dataset.start = String(seg.start);

        const sec0 = Number(seg.start);
        const stamp = document.createElement('span');
        stamp.className = 'c2md-ts c2md-num';
        stamp.dataset.start = String(sec0);
        stamp.textContent = fmtTs(sec0);
        p.appendChild(stamp);

        const say = el('span', 'c2md-say');
        say.dataset.raw = raw;
        if (seg.raw && seg.text && seg.raw !== seg.text) say.dataset.polished = seg.text;
        say.textContent = shown;
        p.appendChild(say);

        sec.appendChild(p);
      }
      body.appendChild(sec);
    }
    return body;
  }

  // ---------- 底部 ----------
  renderFoot() {
    const foot = el('div', 'c2md-panel-foot');
    const { status, settings, polish } = this.state;
    const ready = status === 'ready';

    const copy = button('复制 Markdown', () => this.handlers.onCopy?.(), 'primary');
    copy.disabled = !ready;
    const save = button('保存文字 .md', () => this.handlers.onDownload?.());
    save.disabled = !ready;

    foot.append(copy, save);

    // 勾了润色但还没跑过：把「开始润色」放在最容易看到的位置
    if (settings?.polish && !polish?.hasResult && status === 'ready') {
      const run = button(polish?.running ? '润色中' : '开始润色', () => this.handlers.onRepolish?.());
      run.disabled = Boolean(polish?.running);
      foot.appendChild(run);
    }

    const spacer = el('div', 'c2md-actions-spacer');
    foot.appendChild(spacer);

    const copyText = iconButton({
      iconName: 'copy',
      label: '复制纯文本',
      onClick: () => this.handlers.onCopyText?.(),
    });
    copyText.disabled = !ready;
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

function chip(iconName, text) {
  const span = document.createElement('span');
  if (iconName) span.appendChild(icon(iconName));
  const label = document.createElement('span');
  label.textContent = text ?? '';
  span.appendChild(label);
  return span;
}

function plain(text) {
  const span = document.createElement('span');
  span.className = 'c2md-num';
  span.textContent = text ?? '';
  return span;
}
