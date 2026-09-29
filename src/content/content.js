//! 内容脚本控制器：持有状态、跑管线、渲染面板、响应弹窗。
//!
//! 状态放在这里而不是后台，所以 service worker 被回收、弹窗被关掉、
//! 用户切走标签页，都不会影响正在进行的工作。

import { pickAdapter, siteLabel } from '../adapters/index.js';
import { toErrorState } from './errors.js';
import { Panel } from './panel.js';
import { attachFrames, captureSectionImages } from './visual.js';
import { buildDoc, toMarkdown, toPlainText, fileNameFor } from '../core/format.js';
import { useLocalPolish, LOCAL_POLISH } from '../core/settings.js';
import { polishProgress } from '../core/prompt.js';
import {
  runSubtitlePipeline, runAsrPipeline, polishSegments, finalize, organize,
  eventSectionIndexOf, MissingSourceError, AbortError,
} from './pipeline.js';

const POLL_MS = 1500;
/** 提前润色起步的最少事件数：攒够一点内容就开始，不等转录全部结束。 */
const EARLY_POLISH_MIN_EVENTS = 12;

export class Controller {
  constructor() {
    this.adapter = pickAdapter();
    this.settings = null;
    this.meta = null;
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.status = 'idle';
    this.error = null;
    this.imageError = null;
    this.stageLabel = '';
    this.stageRatio = null;
    this.abort = null;
    this.imageAbort = null;
    this.imagePromise = Promise.resolve(0);
    this.imageQueue = new Map();
    this.imageInFlight = new Set();
    this.imageWorking = false;
    this.polishState = { hasResult: false, running: false, done: 0, total: 0 };
    this.imageCache = new Map();
    this.imagesPending = false;
    this.autoTimer = null;
    // 点过「生成笔记」后才允许切换视频自动生成；关闭浮窗即失效
    this.autoRunArmed = false;
    this.panelDismissed = false;
    this.polishAbort = null;
    this.earlyPolish = { active: false, done: false, promise: null, covered: 0 };
    this.liveEvents = null;
    this.liveSections = null;
    this.polishRestart = false;
    this.finalizingPolish = false;
    this.urlKey = this.currentUrlKey();

    this.panel = new Panel({
      onSettings: (patch) => this.patchSettings(patch),
      onSeek: (sec) => this.seek(sec),
      onCopy: () => this.copyMarkdown(),
      onCopyText: () => this.copyPlainText(),
      onDownload: () => this.download(),
      onRerun: () => {
        this.autoRunArmed = true;
        return this.run();
      },
      onRepolish: () => this.repolish(),
      onOptions: (section) => this.openOptions(section),
      onClose: () => this.closePanel(),
      onSwitchToAsr: () => this.switchToAsr(),
    });
  }

  // ---------- 生命周期 ----------

  async init() {
    this.settings = await send({ type: 'settings.load' }).catch(() => null);
    if (!this.settings) {
      // 后台还没起来时用默认值兜底，界面不至于空白
      const { DEFAULT_SETTINGS } = await import('../core/settings.js');
      this.settings = structuredClone(DEFAULT_SETTINGS);
    }
    this.imageLevel = this.settings.imageLevel;

    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      const handler = this.MESSAGES[message?.type];
      if (!handler) return false;
      Promise.resolve(handler.call(this, message.payload ?? {}))
        .then((value) => respond({ ok: true, value }))
        .catch((error) => respond({ ok: false, error: toErrorState(error) }));
      return true;
    });

    // 设置变了（用户在弹窗或设置页改的）就即时反映到面板
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const next = changes.settings.newValue;
      if (!next) return;
      const old = this.settings;
      const configChanged = next.polishLevel !== old.polishLevel ||
        next.polishEngine !== old.polishEngine ||
        next.llm?.baseUrl !== old.llm?.baseUrl || next.llm?.model !== old.llm?.model;
      const repolish = this.built && !this.finalizingPolish && next.polish && !this.polishState.running &&
        (!old.polish || configChanged);
      if (this.built && next.polish && (this.finalizingPolish || this.polishState.running) && (!old.polish || configChanged)) {
        this.polishRestart = true;
      }
      const resumeEarly = !this.built && this.status === 'running' && next.polish &&
        !this.earlyPolish.active && !this.earlyPolish.done &&
        (this.liveEvents?.length ?? 0) >= EARLY_POLISH_MIN_EVENTS && (!old.polish || configChanged);
      this.settings = next;
      this.panel.setState({ settings: this.settings });
      // 半途取消润色：停掉手头的润色，已完成的段落保留
      if (old.polish && !next.polish && this.polishState.running) this.polishAbort?.abort();
      if (this.meta && (this.built || this.liveSections) && this.imageLevel !== this.settings.imageLevel) this.refreshImages();
      if (this.settings.showPanel && this.doc && !this.panelDismissed) this.panel.mount();
      if (repolish) this.repolish({ reset: configChanged });
      if (resumeEarly) this.startEarlyPolish(this.liveEvents);
    });

    // SPA 换视频：YouTube 与 B 站都是不刷新页面换内容的
    setInterval(() => this.checkNavigation(), POLL_MS);

    // 有缓存内容就恢复出来（后退/前进回来时不用重新抓一遍）
    const cached = await this.loadCache();
    if (cached) {
      this.built = {
        sections: cached.sections,
        segments: cached.sections.flatMap((section) => section.segments),
        sectionIndexOf: cached.sections.flatMap((section, i) => section.segments.map(() => i)),
        stats: cached.stats,
        warnings: cached.warnings ?? [],
      };
      this.built.segments.forEach((seg, id) => { seg.id = id; });
      for (const [t, image] of cached.images ?? []) this.imageCache.set(t, image);
      this.meta = cached.meta;
      this.doc = buildDoc({ ...this.meta, source: cached.stats.source }, cached.sections);
      this.status = 'ready';
      this.polishState.hasResult = Boolean(cached.polished);
      this.previewSections = attachFrames(this.built.sections, this.settings.imageLevel, this.imageCache);
      this.imagesPending = this.settings.imageLevel !== 'none' &&
        this.previewSections.some((section) => section.frames.some((frame) => !this.imageCache.has(frame.t)));
      if (this.settings.showPanel) this.panel.mount();
      if (this.imagesPending) this.refreshImages();
    }
    this.broadcast();
  }

  currentUrlKey() {
    const loc = location;
    const query = new URLSearchParams(loc.search);
    const part = this.adapter.id === 'bilibili' ? `?p=${query.get('p') || '1'}` :
      this.adapter.id === 'youtube' ? `?v=${query.get('v') || ''}` : loc.search;
    return `${this.adapter.id}:${loc.origin}${loc.pathname}${part}`;
  }

  checkNavigation() {
    const key = this.currentUrlKey();
    if (key === this.urlKey) return;
    this.abort?.abort();
    this.imageAbort?.abort();
    this.polishAbort?.abort();
    clearTimeout(this.autoTimer);
    this.urlKey = key;
    // 换视频了：清干净，避免把上一个视频的笔记留在屏幕上
    this.adapter = pickAdapter();
    this.built = null;
    this.previewSections = [];
    this.imageCache.clear();
    this.imageQueue.clear();
    this.imageInFlight.clear();
    this.imagesPending = false;
    this.doc = null;
    this.meta = null;
    // 已武装自动生成：直接进入「加载中」占位（与本地模型转录一致），
    // 不让「暂无笔记」在启动的一秒空窗里闪出来
    this.status = this.autoRunArmed ? 'loading' : 'idle';
    this.error = null;
    this.polishState = { hasResult: false, running: false, done: 0, total: 0 };
    this.earlyPolish = { active: false, done: false, promise: null, covered: 0 };
    this.liveEvents = null;
    this.liveSections = null;
    this.polishRestart = false;
    this.finalizingPolish = false;
    this.panel.setState(this.panelState());
    if (this.autoRunArmed) this.scheduleAutoRun();
  }

  scheduleAutoRun() {
    const key = this.urlKey;
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      if (this.urlKey !== key || !this.autoRunArmed) return;
      if (!this.adapter.video()) return this.scheduleAutoRun();
      this.run();
    }, 1000);
  }

  // ---------- 消息 ----------

  MESSAGES = {
    'c2md.ping': async () => ({
      ready: true,
      site: this.adapter.id,
      siteLabel: siteLabel(this.adapter.id),
      hasVideo: Boolean(this.adapter.video()),
      status: this.status,
      busy: this.status === 'running',
    }),

    'c2md.status': async () => {
      if (!this.meta) {
        this.meta = await this.safeMeta();
        this.broadcast();
      }
      return this.summaryState();
    },

    'c2md.run': () => {
      this.autoRunArmed = true;
      this.run().catch((error) => {
        this.status = 'error';
        this.error = toErrorState(error);
        this.broadcast();
      });
      return { status: this.status };
    },
    'c2md.cancel': async () => this.cancel(),
    'c2md.polish': async () => this.repolish(),
    'c2md.showPanel': async () => {
      this.panelDismissed = false;
      this.panel.mount();
      this.broadcast();
      return { shown: true };
    },
    'c2md.hidePanel': async () => {
      this.closePanel();
      return { shown: false };
    },
    'c2md.seek': async ({ seconds }) => ({ sought: await this.seek(seconds) }),
    'c2md.copy': async () => ({ copied: await this.copyMarkdown() }),
    'c2md.download': async () => this.download(),
    'c2md.openOptions': async ({ section }) => this.openOptions(section),
  };

  summaryState() {
    return {
      status: this.status,
      busy: this.status === 'running',
      site: this.adapter.id,
      siteLabel: siteLabel(this.adapter.id),
      settings: this.settings,
      meta: this.meta
        ? {
            title: this.meta.title,
            uploader: this.meta.uploader,
            duration: this.meta.duration,
            url: this.meta.url,
          }
        : null,
      stats: this.built?.stats ?? null,
      segmented: this.built ? this.built.segments.length : 0,
      polish: { ...this.polishState },
      error: this.error,
      warnings: this.built?.warnings ?? [],
      stageLabel: this.stageLabel,
      stageRatio: this.stageRatio,
      imagesPending: this.imagesPending,
    };
  }

  panelState() {
    return { ...this.summaryState(), error: this.error || this.imageError, sections: this.previewSections };
  }

  broadcast(updatePanel = true) {
    if (updatePanel) this.panel.setState(this.panelState());
    // 弹窗可能开着，也可能没开；没开时这个 sendMessage 会静默失败
    chrome.runtime.sendMessage({ type: 'c2md.state', payload: this.summaryState() }).catch(() => {});
  }

  // ---------- 管线 ----------

  async safeMeta(adapter = this.adapter) {
    try {
      return await adapter.meta();
    } catch (error) {
      return { title: document.title, uploader: '', duration: 0, url: location.href, site: adapter.id, language: '' };
    }
  }

  onProgress(stage, info = {}) {
    if (info.message) this.stageLabel = info.message;
    this.stageRatio = Number.isFinite(info.ratio) ? Math.min(1, Math.max(0, info.ratio)) : null;
    this.status = 'running';
    this.panel.setState({ status: 'running', stageLabel: this.stageLabel, stageRatio: this.stageRatio });
    this.broadcast(false);
  }

  async run() {
    if (this.status === 'running') return { status: 'running' };
    clearTimeout(this.autoTimer);

    this.abort?.abort();
    this.imageAbort?.abort();
    this.imageQueue.clear();
    this.imageInFlight.clear();
    this.polishAbort?.abort();
    this.abort = new AbortController();
    this.polishAbort = new AbortController();
    const runAbort = this.abort;
    const adapter = this.adapter;
    this.status = 'running';
    this.stageRatio = null;
    this.error = null;
    this.imageError = null;
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.polishState = { hasResult: false, running: false, done: 0, total: 0 };
    this.earlyPolish = { active: false, done: false, promise: null, covered: 0 };
    this.liveEvents = null;
    this.liveSections = null;
    this.polishRestart = false;
    this.finalizingPolish = false;
    this.stageLabel = '正在读取页面信息';
    this.panelDismissed = false;
    this.panel.mount();
    this.broadcast();

    try {
      const meta = await this.safeMeta(adapter);
      meta.chapters = await adapter.chapters(meta).catch(() => []);
      meta.chapters = meta.chapters ?? [];
      if (runAbort.signal.aborted) throw new AbortError();

      const common = {
        adapter,
        meta,
        settings: this.settings,
        signal: runAbort.signal,
        onProgress: (stage, info) => {
          if (this.abort === runAbort && !runAbort.signal.aborted) this.onProgress(stage, info);
        },
        onPartial: (events) => {
          if (this.abort !== runAbort || runAbort.signal.aborted) return;
          const partial = organize([...events].sort((a, b) => a.start - b.start), meta);
          this.meta = meta;
          this.liveEvents = events;
          this.liveSections = partial.sections;
          this.refreshImages();
          // 润色不必等转录全部结束：攒够量就先润一批，上一批落定后接着推进
          const batchDue = events.length - (this.earlyPolish.covered ?? 0) >= EARLY_POLISH_MIN_EVENTS;
          const batchFree = !this.earlyPolish.active &&
            ((this.earlyPolish.covered ?? 0) === 0 || this.earlyPolish.done);
          if (this.settings.polish && this.polishReady() && batchDue && batchFree) {
            this.startEarlyPolish(events);
          }
        },
      };

      const built = this.settings.source === 'asr'
        ? await runAsrPipeline(common)
        : await runSubtitlePipeline(common);

      if (runAbort.signal.aborted) throw new AbortError();
      this.meta = meta;
      this.built = built;
      this.finalizingPolish = true;

      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      this.refreshImages();
      if (runAbort.signal.aborted) throw new AbortError();

      // 勾了润色且配置齐全，就在同一次流程里顺带跑掉
      if (this.settings.polish) {
        // 先等提前润色收尾，续润只处理还没润过的段落
        if (this.earlyPolish.promise) await this.earlyPolish.promise.catch(() => {});
        if (runAbort.signal.aborted) throw new AbortError();
        do {
          this.polishRestart = false;
          try {
            await this.runPolish({ resume: true });
          } catch (error) {
            if (runAbort.signal.aborted) throw error;
            if (!(error instanceof AbortError)) this.error = toErrorState(error);
          }
        } while (this.settings.polish && this.polishRestart && !runAbort.signal.aborted);
      }
      if (runAbort.signal.aborted) throw new AbortError();

      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      await this.saveCache();
      this.finalizingPolish = false;
    } catch (error) {
      if (this.abort !== runAbort) return { status: 'stale' };
      if (error instanceof AbortError || runAbort.signal.aborted) {
        this.status = 'idle';
        this.error = null;
        this.built = null;
        this.previewSections = [];
      } else {
        this.status = 'error';
        this.error = toErrorState(error);
        if (error instanceof MissingSourceError && this.settings.source === 'subtitle') {
          this.error.switchToAsr = true;
        }
      }
      this.stageLabel = '';
    }

    if (this.settings.showPanel && !this.panelDismissed) this.panel.mount();
    this.finalizingPolish = false;
    if (this.polishRestart && this.settings.polish && this.built && !this.polishState.running) {
      this.polishRestart = false;
      this.repolish();
    }
    this.broadcast();
    return { status: this.status, error: this.error };
  }

  /**
   * 跑一遍润色。
   * @param {object} [options]
   * @param {object[]} [options.segments] 要润色的段落（默认 this.built.segments；提前润色时传事件列表）
   * @param {number[]} [options.sectionIndexOf] 段落下标 -> 章节下标
   * @param {boolean} [options.resume] 续润：跳过已润色的段落
   * @param {boolean} [options.early] 转录尚未结束的提前润色：不触碰面板正文
   */
  async runPolish(options = {}) {
    const { resume = false, early = false } = options;
    const segments = options.segments ?? this.built?.segments;
    const sectionIndexOf = options.sectionIndexOf ?? this.built?.sectionIndexOf;
    if (!segments?.length) return;
    if (!this.polishAbort || this.polishAbort.signal.aborted) this.polishAbort = new AbortController();
    const signal = AbortSignal.any([this.polishAbort.signal, this.abort?.signal].filter(Boolean));
    this.polishState = { hasResult: this.polishState.hasResult, running: true, done: 0, total: 0 };
    this.panel.setState({ polish: this.polishState });
    try {
    const useLocal = useLocalPolish(this.settings);
    if (this.settings.polishEngine === 'custom' && (!this.settings.llm.baseUrl || !this.settings.llm.model)) {
      throw new Error('请先填写自定义模型的服务地址和模型名');
    }
    const polishSettings = useLocal ? await this.localPolishSettings(signal) : this.settings;
    const result = await polishSegments({
      segments,
      sectionIndexOf,
      meta: this.meta,
      settings: polishSettings,
      signal,
      resume,
      // 自备 LLM 三次都失败时，静默换成本机润色
      fallback: useLocal ? undefined : { ensure: () => this.ensureLocalPolish(signal) },
      onProgress: () => {
        // 分母是视频总时长，恒定不变；分子是已润色内容的时长，圆环只进不退
        this.polishState = { ...this.polishState, running: true, ...polishProgress(segments, this.meta?.duration) };
        this.panel.setState({ polish: this.polishState });
        this.broadcast(false);
      },
      onSegment: (id) => {
        this.polishState.hasResult = true;
        if (!early && this.built?.segments?.[id]) this.panel.updateSegment(this.built.segments[id]);
      },
      onReset: () => {
        if (!early) this.panel.setState({ sections: this.previewSections });
      },
    });

    if (signal.aborted) throw new AbortError();

    if (result.failed && !early) {
      this.built.warnings.push(`润色失败 ${result.failed}/${result.chunks}：${result.firstError || '模型未返回可用文本'}`);
    }
    this.polishState = { hasResult: true, running: false, ...polishProgress(segments, this.meta?.duration) };
    if (!early) {
      this.doc = finalize(this.built, this.meta, this.settings);
      await this.saveCache();
    }
    } finally {
      this.polishState.running = false;
      this.panel.setState({ polish: this.polishState });
    }
  }

  /** 提前润色：转录还在进行时就润已经到手的事件；事件对象就地更新。 */
  startEarlyPolish(events) {
    this.earlyPolish.active = true;
    this.earlyPolish.covered = events.length;
    this.earlyPolish.promise = this.runPolish({
      segments: events,
      sectionIndexOf: eventSectionIndexOf(events, this.meta),
      resume: true,
      early: true,
    })
      .then(() => { this.earlyPolish.done = true; })
      .catch(() => {})
      .finally(() => { this.earlyPolish.active = false; });
  }

  /** 润色是否具备启动条件（自定义模型未配置时不提前开跑）。 */
  polishReady() {
    return useLocalPolish(this.settings) ||
      !(this.settings.polishEngine === 'custom' && (!this.settings.llm.baseUrl || !this.settings.llm.model));
  }

  /** 关闭浮窗：自动生成随之失效，直到用户再次手动点生成。 */
  closePanel() {
    this.autoRunArmed = false;
    this.panelDismissed = true;
    this.panel.unmount();
  }

  /** 本机润色的 LLM 配置（沿用术语表与自定义指令）。 */
  localPolishLlm() {
    return { ...this.settings.llm, ...LOCAL_POLISH, concurrency: 1 };
  }

  /** 启动本机润色服务并等它就绪；启动进度照常显示。 */
  async localPolishSettings(signal) {
    await this.waitLocalPolish(signal, (message) => {
      this.stageLabel = message;
      this.broadcast();
    });
    this.stageLabel = '';
    return { ...this.settings, llm: this.localPolishLlm() };
  }

  /** 静默确保本机润色可用：不打扰进度显示，只在失败时抛错。 */
  async ensureLocalPolish(signal) {
    await this.waitLocalPolish(signal);
    return this.localPolishLlm();
  }

  async waitLocalPolish(signal, onState = () => {}) {
    const started = await send({ type: 'polish.local.start' });
    if (started.state === 'error') throw new Error(started.message);
    let state = started;
    while (state.state !== 'ready') {
      if (signal?.aborted) throw new AbortError();
      onState(state.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      state = await send({ type: 'polish.local.status' });
      if (state.state === 'error') throw new Error(state.message);
    }
  }

  async repolish(options = {}) {
    if (!this.built) return { status: 'none' };
    if (!this.polishAbort || this.polishAbort.signal.aborted) this.polishAbort = new AbortController();
    this.polishState = { ...this.polishState, running: true };
    this.panel.setState(this.panelState());
    try {
      // 默认续润（跳过已润色的段落）；设置变了才从头再来
      do {
        this.polishRestart = false;
        try {
          await this.runPolish({ resume: !options.reset });
        } catch (error) {
          if (!(error instanceof AbortError) || !this.settings.polish || !this.polishRestart) throw error;
        }
        options.reset = false;
      } while (this.settings.polish && this.polishRestart);
      this.error = null;
    } catch (error) {
      this.polishState.running = false;
      if (!(error instanceof AbortError)) this.error = toErrorState(error);
    }
    this.broadcast();
    return { status: 'done' };
  }

  cancel() {
    this.abort?.abort();
    this.imageAbort?.abort();
    this.polishAbort?.abort();
    this.status = 'idle';
    this.stageLabel = '';
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.broadcast();
    return { cancelled: true };
  }

  async switchToAsr() {
    await this.patchSettings({ source: 'asr' });
    this.settings.source = 'asr';
    return this.run();
  }

  // ---------- 动作 ----------

  async seek(seconds) {
    const ok = await this.adapter.seek(seconds).catch(() => false);
    if (!ok) return false;
    // 短暂标一下当前段落，用户回到页面时知道跳到哪了
    if (this.panel.isMounted) {
      for (const p of this.panel.scope.querySelectorAll('.c2md-para[data-active]')) {
        delete p.dataset.active;
      }
      const target = this.panel.scope.querySelector(`.c2md-para[data-start="${Math.floor(seconds)}"]`)
        ?? null;
      if (target) {
        target.dataset.active = 'true';
        setTimeout(() => delete target.dataset.active, 1600);
      }
    }
    return true;
  }

  markdown() {
    if (!this.doc) return '';
    return toMarkdown(this.doc, {
      timestamps: this.settings.showTimestamps,
    });
  }

  plainText() {
    const available = this.built?.sections ?? this.liveSections;
    if (!available?.some((section) => section.segments.some((seg) => seg.raw ?? seg.text))) return '';
    const original = !this.settings.polish;
    const sections = available.map((section) => ({
      ...section,
      segments: section.segments.map((seg) => ({
        ...seg,
        text: original ? (seg.raw ?? seg.text) : seg.text,
        state: original ? 'kept' : seg.state,
      })),
    }));
    return toPlainText({ meta: this.meta, sections }, { timestamps: this.settings.showTimestamps });
  }

  async copyMarkdown() {
    if (this.imagesPending && this.settings.imageLevel !== 'none') return false;
    return copyText(this.markdown());
  }

  async copyPlainText() {
    return copyText(this.plainText());
  }

  async download() {
    if (!this.doc) return { saved: false };
    if (this.imagesPending && this.settings.imageLevel !== 'none') return { saved: false, pending: true };
    try {
      const visibleSections = this.previewSections.filter((section) => section.segments.some((seg) => seg.state !== 'skipped'));
      // 只导出落在保留段落上的帧，按出现顺序编号
      const pictures = [];
      const sections = visibleSections.map((section) => ({
        ...section,
        frames: this.settings.imageLevel === 'none' ? [] : (section.frames ?? [])
          .filter((frame) => frame.image && section.segments.some((seg) => seg.state !== 'skipped' && seg.start === frame.t))
          .map((frame) => {
            pictures.push(frame.image);
            return { ...frame, image: `frames/slide_${String(pictures.length).padStart(4, '0')}.jpg` };
          }),
      }));
      if (this.settings.imageLevel !== 'none' && !pictures.length) {
        throw new Error('未能取得离线视频画面，请检查本机助手与媒体下载。');
      }
      if (pictures.length) {
        return await send({
          type: 'file.saveBundle',
          payload: {
            folder: this.doc.meta.title,
            markdown: toMarkdown({ ...this.doc, sections }, { timestamps: this.settings.showTimestamps, images: true }),
            images: pictures,
          },
        });
      }
      return await send({
        type: 'file.save',
        payload: {
          filename: fileNameFor(this.doc.meta.title, 'md'),
          text: this.markdown(),
        },
      });
    } catch (error) {
      this.error = toErrorState(error);
      this.panel.setState(this.panelState());
      return { saved: false };
    }
  }

  async openOptions(section) {
    return send({ type: 'ui.openOptions', payload: { section } });
  }

  async patchSettings(patch) {
    const previousLevel = this.settings.imageLevel;
    const reply = await send({ type: 'settings.save', payload: { patch } });
    if (reply?.settings) {
      this.settings = reply.settings;
      if (this.meta && (this.built || this.liveSections) && previousLevel !== this.settings.imageLevel && this.imageLevel !== this.settings.imageLevel) this.refreshImages();
      this.broadcast();
    }
    return reply;
  }

  refreshImages() {
    const sections = this.built?.sections ?? this.liveSections;
    if (!sections || !this.meta) return this.imagePromise;
    if (this.imageLevel !== this.settings.imageLevel) {
      this.imageAbort?.abort();
      this.imageQueue.clear();
      this.imageInFlight.clear();
    }
    if (!this.imageAbort || this.imageAbort.signal.aborted) this.imageAbort = new AbortController();
    if (this.imageLevel !== this.settings.imageLevel) this.imageError = null;
    this.imageLevel = this.settings.imageLevel;
    // 密度只决定每个分节取哪些帧时刻，分节与段落原地不动
    this.previewSections = attachFrames(sections, this.imageLevel, this.imageCache);
    this.imagesPending = this.imageLevel !== 'none' &&
      this.previewSections.some((section) => section.frames.some((frame) => !this.imageCache.has(frame.t)));
    this.broadcast();
    if (this.imageLevel !== 'none' && !this.imageError) {
      for (const section of this.previewSections) {
        for (const frame of section.frames) {
          if (!this.imageCache.has(frame.t) && !this.imageQueue.has(frame.t) && !this.imageInFlight.has(frame.t)) {
            this.imageQueue.set(frame.t, frame);
          }
        }
      }
      if (!this.imageWorking && this.imageQueue.size) this.imagePromise = this.drainImages();
    }
    return this.imagePromise;
  }

  async drainImages() {
    this.imageWorking = true;
    const abort = this.imageAbort;
    const sourceUrl = this.meta.url;
    try {
      while (!abort.signal.aborted && this.imageQueue.size) {
        const batch = [...this.imageQueue.values()];
        this.imageQueue.clear();
        for (const frame of batch) this.imageInFlight.add(frame.t);
        try { await captureSectionImages(sourceUrl, batch, abort.signal, (frame) => {
          if (abort.signal.aborted) return;
          this.imageCache.set(frame.t, frame.image);
          const visible = this.previewSections
            .flatMap((section) => section.frames ?? [])
            .find((item) => item.t === frame.t);
          if (visible) visible.image = frame.image;
          this.imagesPending = this.imageLevel !== 'none' &&
            this.previewSections.some((section) => section.frames.some((item) => !this.imageCache.has(item.t)));
          this.broadcast();
        }); } finally { for (const frame of batch) this.imageInFlight.delete(frame.t); }
        if (this.built) await this.saveCache();
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.imageQueue.clear();
        this.imageError = toErrorState(error);
        this.broadcast();
      }
    } finally {
      this.imageWorking = false;
      if (abort.signal.aborted && this.imageQueue.size && this.imageAbort !== abort) this.imagePromise = this.drainImages();
    }
  }

  // ---------- 缓存 ----------

  cacheKey() {
    return `cache:${this.adapter.id}:${location.pathname}${location.search}`;
  }

  /** 存最近一次的笔记。存不进去（配额满）也不算错，只是下次要重新抓。 */
  async saveCache() {
    try {
      await chrome.storage.session?.set({
        [this.cacheKey()]: {
          // 记下产出这份笔记的扩展版本：代码更新（修 bug、换数据源）后，
          // 旧逻辑产出的内容不能冒充新结果，loadCache 靠它作废旧缓存
          version: chrome.runtime.getManifest().version,
          meta: this.meta,
          sections: this.built.sections,
          // 已取到的帧按时刻存，密度换挡时同款时刻直接复用
          images: [...this.imageCache.entries()],
          stats: this.built.stats,
          warnings: this.built.warnings,
          polished: this.polishState.hasResult,
          savedAt: Date.now(),
        },
      });
    } catch {
      /* session 存储不可用或超配额，忽略 */
    }
  }

  async loadCache() {
    try {
      const key = this.cacheKey();
      const stored = await chrome.storage.session?.get(key);
      const entry = stored?.[key];
      if (!entry) return null;
      // 一小时后过期：视频可能改了，旧笔记容易误导
      if (Date.now() - (entry.savedAt ?? 0) > 3600_000) return null;
      // 版本不符：旧代码产出的内容（可能带着已修复的 bug）不作数
      if (entry.version !== chrome.runtime.getManifest().version) return null;
      return entry;
    } catch {
      return null;
    }
  }
}

/** 通过后台发消息；后台没响应时抛一个能看懂的错。 */
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply) throw new Error('扩展后台没有响应。刷新页面后重试。');
  if (!reply.ok) throw new Error(reply.error ?? '未知错误');
  return reply.value;
}

/**
 * 复制到剪贴板。
 * navigator.clipboard 需要文档处于聚焦状态，YouTube 的某些状态下会拒绝；
 * 所以保留一条 execCommand 的兜底路径。
 */
export async function copyText(text) {
  if (!text) return false;
  let area;
  try {
    area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy');
    if (ok) return true;
  } catch {
    /* 尝试扩展剪贴板权限 */
  } finally {
    area?.remove();
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function start() {
  const controller = new Controller();
  window.__c2mdController = controller;
  await controller.init();
  return controller;
}
