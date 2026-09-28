//! 内容脚本控制器：持有状态、跑管线、渲染面板、响应弹窗。
//!
//! 状态放在这里而不是后台，所以 service worker 被回收、弹窗被关掉、
//! 用户切走标签页，都不会影响正在进行的工作。

import { pickAdapter, siteLabel } from '../adapters/index.js';
import { toErrorState } from './errors.js';
import { Panel } from './panel.js';
import { visualSections, captureSectionImages } from './visual.js';
import { buildDoc, toMarkdown, toPlainText, fileNameFor } from '../core/format.js';
import { useLocalPolish, LOCAL_POLISH } from '../core/settings.js';
import {
  runSubtitlePipeline, runAsrPipeline, polishSegments, finalize, organize,
  MissingSourceError, AbortError,
} from './pipeline.js';

const POLL_MS = 1500;

class Controller {
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
    this.polishState = { hasResult: false, running: false, done: 0, total: 0 };
    this.imageCache = new Map();
    this.imagesPending = false;
    this.autoTimer = null;
    // 点过「生成笔记」后才允许切换视频自动生成；关闭浮窗即失效
    this.autoRunArmed = false;
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
      const repolish = this.built && next.polish && !this.polishState.running &&
        (!this.settings.polish || next.polishLevel !== this.settings.polishLevel ||
          next.polishEngine !== this.settings.polishEngine ||
          next.llm?.baseUrl !== this.settings.llm?.baseUrl || next.llm?.model !== this.settings.llm?.model);
      this.settings = next;
      this.panel.setState({ settings: this.settings });
      if (this.built && this.imageLevel !== this.settings.imageLevel) this.refreshImages();
      if (this.settings.showPanel && this.doc) this.panel.mount();
      if (repolish) this.repolish();
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
      this.previewSections = cached.imageLevel === this.settings.imageLevel
        ? cached.previewSections ?? [] : visualSections(cached.sections, cached.meta.duration, this.settings.imageLevel);
      this.meta = cached.meta;
      this.doc = buildDoc({ ...this.meta, source: cached.stats.source }, cached.sections);
      this.status = 'ready';
      this.polishState.hasResult = Boolean(cached.polished);
      for (const section of cached.previewSections ?? []) if (section.image) this.imageCache.set(section.t, section.image);
      this.imagesPending = this.settings.imageLevel !== 'none' && cached.imageComplete !== true;
      if (this.settings.showPanel) this.panel.mount();
      if (cached.imageLevel !== this.settings.imageLevel || this.imagesPending) this.refreshImages();
    }
    this.broadcast();
  }

  currentUrlKey() {
    const loc = location;
    return `${this.adapter.id}:${loc.origin}${loc.pathname}${loc.search}`;
  }

  checkNavigation() {
    const key = this.currentUrlKey();
    if (key === this.urlKey) return;
    this.abort?.abort();
    this.imageAbort?.abort();
    clearTimeout(this.autoTimer);
    this.urlKey = key;
    // 换视频了：清干净，避免把上一个视频的笔记留在屏幕上
    this.adapter = pickAdapter();
    this.built = null;
    this.previewSections = [];
    this.imageCache.clear();
    this.imagesPending = false;
    this.doc = null;
    this.meta = null;
    this.status = 'idle';
    this.error = null;
    this.polishState = { hasResult: false, running: false, done: 0, total: 0 };
    this.panel.setState(this.panelState());
    this.scheduleAutoRun();
  }

  scheduleAutoRun() {
    const key = this.urlKey;
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      if (this.urlKey !== key) return;
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
      this.panel.mount();
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
    this.abort = new AbortController();
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
    this.stageLabel = '正在读取页面信息';
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
          this.previewSections = visualSections(partial.sections, meta.duration, this.settings.imageLevel);
          this.broadcast();
        },
      };

      const built = this.settings.source === 'asr'
        ? await runAsrPipeline(common)
        : await runSubtitlePipeline(common);

      if (runAbort.signal.aborted) throw new AbortError();
      this.meta = meta;
      this.built = built;

      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      this.refreshImages(); // 文字先出现，截图随后补齐。
      if (runAbort.signal.aborted) throw new AbortError();

      // 勾了润色且配置齐全，就在同一次流程里顺带跑掉
      if (this.settings.polish) {
        try {
          await this.runPolish(runAbort.signal);
        } catch (error) {
          if (runAbort.signal.aborted) throw error;
          this.polishState.running = false;
          this.error = toErrorState(error);
        }
      }
      if (runAbort.signal.aborted) throw new AbortError();

      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      await this.saveCache();
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

    if (this.settings.showPanel) this.panel.mount();
    this.broadcast();
    return { status: this.status, error: this.error };
  }

  async runPolish(signal = this.abort?.signal) {
    if (!this.built?.segments?.length) return;
    this.polishState = { hasResult: this.polishState.hasResult, running: true, done: 0, total: 0 };
    this.panel.setState({ polish: this.polishState });
    const useLocal = useLocalPolish(this.settings);
    if (this.settings.polishEngine === 'custom' && (!this.settings.llm.baseUrl || !this.settings.llm.model)) {
      throw new Error('请先填写自定义模型的服务地址和模型名');
    }
    const polishSettings = useLocal ? await this.localPolishSettings(signal) : this.settings;
    const result = await polishSegments({
      segments: this.built.segments,
      sectionIndexOf: this.built.sectionIndexOf,
      meta: this.meta,
      settings: polishSettings,
      signal,
      // 自备 LLM 三次都失败时，静默换成本机润色
      fallback: useLocal ? undefined : { ensure: () => this.ensureLocalPolish(signal) },
      onProgress: (done, total) => {
        this.polishState = { ...this.polishState, running: true, done, total };
        this.panel.setState({ polish: this.polishState });
        this.broadcast(false);
      },
      onSegment: (id) => {
        this.polishState.hasResult = true;
        this.panel.updateSegment(this.built.segments[id]);
      },
      onReset: () => this.panel.setState({ sections: this.previewSections }),
    });

    if (signal?.aborted) throw new AbortError();

    if (result.failed) {
      this.built.warnings.push(`润色失败 ${result.failed}/${result.chunks}：${result.firstError || '模型未返回可用文本'}`);
    }
    this.polishState = { hasResult: true, running: false, done: result.chunks, total: result.chunks };
    this.doc = finalize(this.built, this.meta, this.settings);
    await this.saveCache();
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

  async repolish() {
    if (!this.built) return { status: 'none' };
    this.polishState = { ...this.polishState, running: true };
    this.panel.setState(this.panelState());
    try {
      await this.runPolish();
      this.error = null;
    } catch (error) {
      this.polishState.running = false;
      this.error = toErrorState(error);
    }
    this.broadcast();
    return { status: 'done' };
  }

  cancel() {
    this.abort?.abort();
    this.imageAbort?.abort();
    this.status = 'idle';
    this.stageLabel = '';
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.broadcast();
    return { cancelled: true };
  }

  /** 关闭浮窗：自动生成随之失效，直到用户再次手动点生成。 */
  closePanel() {
    this.autoRunArmed = false;
    this.panel.unmount();
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
    if (!this.built) return '';
    const original = !this.settings.polish;
    const sections = this.built.sections.map((section) => ({
      ...section,
      segments: section.segments.map((seg) => ({ ...seg, text: original ? (seg.raw ?? seg.text) : seg.text,
        state: original ? 'kept' : seg.state })),
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
      const pictures = this.settings.imageLevel === 'none'
        ? [] : visibleSections.filter((section) => section.image);
      if (this.settings.imageLevel !== 'none' && !pictures.length) {
        throw new Error('未能取得离线视频画面，请检查本机助手与媒体下载。');
      }
      if (pictures.length) {
        let number = 0;
        const sections = visibleSections.map((section) => ({
          ...section,
          image: section.image ? `frames/slide_${String(++number).padStart(4, '0')}.jpg` : '',
        }));
        return await send({
          type: 'file.saveBundle',
          payload: {
            folder: this.doc.meta.title,
            markdown: toMarkdown({ ...this.doc, sections }, { timestamps: this.settings.showTimestamps, images: true }),
            images: pictures.map((section) => section.image),
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
      if (this.built && previousLevel !== this.settings.imageLevel && this.imageLevel !== this.settings.imageLevel) this.refreshImages();
      this.broadcast();
    }
    return reply;
  }

  refreshImages() {
    const previous = this.imagePromise;
    this.imageError = null;
    if (!this.imageAbort || this.imageAbort.signal.aborted) this.imageAbort = new AbortController();
    this.imageLevel = this.settings.imageLevel;
    const level = this.imageLevel;
    this.previewSections = visualSections(this.built.sections, this.meta.duration, this.imageLevel);
    for (const section of this.previewSections) section.image = this.imageCache.get(section.t) ?? '';
    this.imagesPending = this.imageLevel !== 'none' && this.previewSections.some((section) => !this.imageCache.has(section.t));
    this.broadcast();
    if (this.imageLevel === 'none') {
      this.imageAbort.abort();
      return this.imagePromise = Promise.resolve(0);
    }
    const current = this.imageAbort;
    this.imagePromise = Promise.resolve(previous).then(() => current.signal.aborted ? 0 :
      captureSectionImages(this.meta.url, visualSections(this.built.sections, this.meta.duration, level).map((section) => ({
        ...section, image: this.imageCache.get(section.t) ?? '', captured: this.imageCache.has(section.t),
      })), current.signal,
        (section) => { if (!current.signal.aborted) {
          this.imageCache.set(section.t, section.image);
          const visible = this.previewSections.find((item) => item.t === section.t);
          if (visible) visible.image = section.image;
          this.broadcast();
        } }))
      .then(async (count) => {
        if (!current.signal.aborted) {
          for (const section of this.previewSections) section.image = this.imageCache.get(section.t) ?? '';
          this.imagesPending = this.imageLevel !== 'none' && this.previewSections.some((section) => !this.imageCache.has(section.t));
          this.broadcast();
          await this.saveCache();
        }
        return count;
      }).catch((error) => {
        if (!current.signal.aborted) {
          this.imageError = toErrorState(error);
          this.broadcast();
        }
        return 0;
      });
    return this.imagePromise;
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
          meta: this.meta,
          sections: this.built.sections,
          previewSections: this.previewSections,
          imageLevel: this.settings.imageLevel,
          imageComplete: !this.imagesPending,
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
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 走兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
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
