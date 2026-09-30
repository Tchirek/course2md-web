//! 视频标题末尾的「↗」：点一下就开始生成笔记。
//!
//! 按钮放在影子 DOM 里，页面样式碰不到它，它也不影响页面。两站的单页应用换视频时会重绘
//! 标题，所以定时确认按钮还在、位置还对，不在就补上。

const ENSURE_MS = 800;

/**
 * 各站标题的位置与放法：
 * - inside：放进标题元素里、紧跟文字（YouTube 标题最多两行，文字是行内元素）；
 * - after：放在标题元素后面（B 站标题是弹性布局里单行加省略号的一项，放里面会被省略号吞掉）。
 * avoid：与标题同一行、页面自己绝对定位的按钮（B 站长标题右端的「展开」），箭头要给它让位。
 */
const PLACES = {
  youtube: { selector: 'ytd-watch-metadata #title h1', mode: 'inside' },
  bilibili: { selector: '.video-info-title-inner h1.video-title', mode: 'after', avoid: '.video-info-title .show-more' },
};

const STYLE = `
  :host { display: inline-flex; vertical-align: baseline; flex: none; margin-inline-start: 0.3em; }
  button {
    all: unset;
    display: inline-grid;
    place-items: center;
    width: 1.15em;
    height: 1.15em;
    border-radius: 0.3em;
    color: currentColor;
    opacity: 0.5;
    cursor: pointer;
    transform: translateY(0.12em);
    transition: opacity 120ms, background-color 120ms, color 120ms;
  }
  :host([data-mode="after"]) { align-self: center; }
  :host([data-mode="after"]) button { transform: none; }
  button:hover, button:focus-visible { opacity: 1; color: #d9480f; background: rgba(217, 72, 15, 0.1); }
  button:focus-visible { outline: 2px solid #d9480f; outline-offset: 1px; }
  button[aria-busy="true"] { opacity: 0.9; color: #d9480f; cursor: progress; }
  button[aria-busy="true"] svg { animation: c2md-pulse 1.2s ease-in-out infinite; }
  svg { width: 0.8em; height: 0.8em; }
  @keyframes c2md-pulse { 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { button[aria-busy="true"] svg { animation: none; } }
`;

const ARROW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12 12 4M5.5 4H12v6.5"/></svg>';

export class TitleLauncher {
  /**
   * @param {() => string} siteId 当前页面的站点（换视频后适配器可能变）
   * @param {() => void} onLaunch
   */
  constructor(siteId, onLaunch) {
    this.siteId = siteId;
    this.onLaunch = onLaunch;
    this.busy = false;
    /** 因截断而放到标题下方时的标题文字 */
    this.clippedText = null;
    this.host = document.createElement('span');
    this.host.setAttribute('data-c2md-launcher', '');
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.innerHTML = ARROW;
    this.button.addEventListener('click', (event) => {
      // 标题本身可能带点击行为（展开、跳转），不让它跟着触发
      event.preventDefault();
      event.stopPropagation();
      this.onLaunch();
    });
    root.append(style, this.button);
    this.setBusy(false);
  }

  start() {
    this.ensure();
    setInterval(() => this.ensure(), ENSURE_MS);
  }

  /** 生成进行中：箭头保持高亮并缓慢闪烁，提示已经在做了。 */
  setBusy(busy) {
    this.busy = busy;
    this.button.setAttribute('aria-busy', String(busy));
    const label = busy ? '正在生成笔记' : '生成笔记（优先用平台字幕）';
    this.button.title = label;
    this.button.setAttribute('aria-label', `course2md：${label}`);
  }

  ensure() {
    const place = PLACES[this.siteId()];
    const title = place && /** @type {HTMLElement|null} */ (document.querySelector(place.selector));
    if (!title) {
      this.host.remove();
      return;
    }
    this.matchSize(title);
    this.host.dataset.mode = place.mode;
    if (place.mode === 'after') {
      if (this.host.previousElementSibling !== title) title.after(this.host);
      this.makeRoom(title, place.avoid);
      return;
    }
    // 放在标题里；标题过长被两行截断时箭头会落在省略号之后看不见，就改放到标题下方，
    // 直到标题文字变了（换了视频）再试着放回去
    const text = title.textContent;
    if (this.host.parentElement === title) {
      if (this.clippedBy(title)) this.moveBelow(title, text);
      return;
    }
    if (this.host.previousElementSibling === title && this.clippedText === text) return;
    title.append(this.host);
    if (this.clippedBy(title)) this.moveBelow(title, text);
  }

  moveBelow(title, text) {
    title.after(this.host);
    this.clippedText = text;
  }

  /** 右侧有页面自己的按钮时留出它的宽度（标题会随之收窄，省略号前移）。 */
  makeRoom(title, avoid) {
    const other = avoid && /** @type {HTMLElement|null} */ (document.querySelector(avoid));
    const box = other?.getBoundingClientRect();
    const edge = title.parentElement?.getBoundingClientRect();
    const room = box?.width && edge ? `${Math.ceil(edge.right - box.left) + 4}px` : '';
    if (this.host.style.marginInlineEnd !== room) this.host.style.marginInlineEnd = room;
  }

  /** 放在标题外面时继承不到标题的字号，照着标题定大小（放在里面时这样做也无妨）。 */
  matchSize(title) {
    const size = getComputedStyle(title).fontSize;
    if (this.host.style.fontSize !== size) this.host.style.fontSize = size;
  }

  clippedBy(title) {
    const box = title.getBoundingClientRect();
    const own = this.host.getBoundingClientRect();
    return box.height > 0 && (own.height === 0 || own.bottom > box.bottom + 1 || own.right > box.right + 1);
  }
}
