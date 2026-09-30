//! 内容脚本控制器：持有状态、跑管线、渲染面板、响应弹窗。
//!
//! 状态放在这里而不是后台，所以 service worker 被回收、弹窗被关掉、
//! 用户切走标签页，都不会影响正在进行的工作。

import { pickAdapter, siteLabel } from '../adapters/index.js';
import { toErrorState } from './errors.js';
import { Panel } from './panel.js';
import { attachFrames } from './visual.js';
import { buildDoc, fileNameFor } from '../core/format.js';
import { runSubtitlePipeline, runAsrPipeline, finalize, organize, MissingSourceError, AbortError } from './pipeline.js';
import { copyText, send } from './messaging.js';
import { imageBundle, markdownOf, plainTextOf } from './exporter.js';
import { loadSession, saveSession, sessionKey } from './session-cache.js';
import { PolishCoordinator } from './polish-coordinator.js';
import { FrameLoader } from './frame-loader.js';
import { ensureFreshCode, extensionGone, resumeAfterExtensionReload, takeResumeRequest } from './freshness.js';

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
    /** @type {Promise<unknown>} */
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
    // 只作用于下一次生成的临时选择（如标题旁的按钮指定优先用平台字幕），不改设置
    this.nextRunOverrides = null;
    this.panelDismissed = false;
    this.polishAbort = null;
    this.earlyPolish = { active: false, done: false, promise: null, covered: 0 };
    this.liveEvents = null;
    this.liveSections = null;
    this.polishRestart = false;
    this.finalizingPolish = false;
    this.urlKey = this.currentUrlKey();
    this.polisher = new PolishCoordinator(this);
    this.frames = new FrameLoader(this);

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
      onRepolish: () => this.polisher.repolish(),
      onOptions: (section) => this.openOptions(section),
      onClose: () => this.closePanel(),
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
      const next = /** @type {any} */ (changes.settings.newValue);
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
      if (this.meta && (this.built || this.liveSections) && this.imageLevel !== this.settings.imageLevel) this.frames.refreshImages();
      if (this.settings.showPanel && this.doc && !this.panelDismissed) this.panel.mount();
      if (repolish) this.polisher.repolish({ reset: configChanged });
      if (resumeEarly) this.polisher.startEarlyPolish(this.liveEvents);
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
      if (this.imagesPending) this.frames.refreshImages();
    }
    this.broadcast();

    // 扩展重新加载时没做完的生成：页面刷新后接着做
    const resume = takeResumeRequest(this.urlKey);
    if (resume) {
      this.nextRunOverrides = resume.overrides ?? null;
      this.autoRunArmed = true;
      this.status = 'loading';
      this.panelDismissed = false;
      this.panel.mount();
      this.panel.setState(this.panelState());
      this.scheduleAutoRun();
    }
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
    'c2md.polish': async () => this.polisher.repolish(),
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
      // 自動切り替えの知らせは、文字起こしの途中や失敗時にも見えるようにする（完成後は built.warnings にある）
      warnings: this.built?.warnings ?? (this.fallbackNotice ? [this.fallbackNotice] : []),
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
    const overrides = this.nextRunOverrides ?? {};
    this.nextRunOverrides = null;

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
    this.fallbackNotice = null;
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

    // 后台若还是旧代码（改了文件却没重载扩展），新旧不合会出各种怪错：先重载扩展、刷新页面再接着生成
    if (await ensureFreshCode()) return this.resumeAfterReload(overrides);
    if (runAbort.signal.aborted || this.abort !== runAbort) return { status: 'stale' };

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
          this.frames.refreshImages();
          // 润色不必等转录全部结束：攒够量就先润一批，上一批落定后接着推进
          const batchDue = events.length - (this.earlyPolish.covered ?? 0) >= EARLY_POLISH_MIN_EVENTS;
          const batchFree = !this.earlyPolish.active &&
            ((this.earlyPolish.covered ?? 0) === 0 || this.earlyPolish.done);
          if (this.settings.polish && this.polisher.polishReady() && batchDue && batchFree) {
            this.polisher.startEarlyPolish(events);
          }
        },
      };

      let built;
      if ((overrides.source ?? this.settings.source) === 'asr') {
        built = await runAsrPipeline(common);
      } else {
        try {
          built = await runSubtitlePipeline(common);
        } catch (error) {
          if (!(error instanceof MissingSourceError) || runAbort.signal.aborted) throw error;
          // 平台字幕が使えなければ、この回だけ本機の文字起こしへ自動で切り替える。
          // 設定は変えない：次の動画に字幕があればそのまま字幕を使う
          this.fallbackNotice = `${error.brief ?? '没有可用的平台字幕'}，已自动改用本地模型转录`;
          this.broadcast();
          built = await runAsrPipeline(common);
          built.warnings.unshift(this.fallbackNotice);
        }
      }

      if (runAbort.signal.aborted) throw new AbortError();
      this.meta = meta;
      this.built = built;
      this.finalizingPolish = true;

      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      this.frames.refreshImages();
      if (runAbort.signal.aborted) throw new AbortError();

      // 勾了润色且配置齐全，就在同一次流程里顺带跑掉
      if (this.settings.polish) {
        // 先等提前润色收尾，续润只处理还没润过的段落
        if (this.earlyPolish.promise) await this.earlyPolish.promise.catch(() => {});
        if (runAbort.signal.aborted) throw new AbortError();
        do {
          this.polishRestart = false;
          try {
            await this.polisher.runPolish({ resume: true });
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
      // 途中扩展被重新加载（例如后台发现自己是旧代码而自行重载）：刷新页面接着生成
      if (extensionGone()) return this.resumeAfterReload(overrides);
      if (error instanceof AbortError || runAbort.signal.aborted) {
        this.status = 'idle';
        this.error = null;
        this.built = null;
        this.previewSections = [];
      } else {
        this.status = 'error';
        this.error = toErrorState(error);
      }
      this.stageLabel = '';
    }

    if (this.settings.showPanel && !this.panelDismissed) this.panel.mount();
    this.finalizingPolish = false;
    if (this.polishRestart && this.settings.polish && this.built && !this.polishState.running) {
      this.polishRestart = false;
      this.polisher.repolish();
    }
    this.broadcast();
    return { status: this.status, error: this.error };
  }


  /** 扩展正在重新加载：面板说明缘由，扩展起来后刷新页面、接着生成。 */
  resumeAfterReload(overrides) {
    this.status = 'running';
    this.stageLabel = '扩展已更新，正在重新加载页面后继续';
    this.stageRatio = null;
    this.panel.setState({ status: 'running', stageLabel: this.stageLabel, stageRatio: null });
    resumeAfterExtensionReload({ page: this.urlKey, overrides });
    return { status: 'running' };
  }

  /** 关闭浮窗：自动生成随之失效，直到用户再次手动点生成。 */
  closePanel() {
    this.autoRunArmed = false;
    this.panelDismissed = true;
    this.panel.unmount();
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

  // ---------- 动作 ----------

  async seek(seconds) {
    const ok = await this.adapter.seek(seconds).catch(() => false);
    if (!ok) return false;
    // 短暂标一下当前段落，用户回到页面时知道跳到哪了
    if (this.panel.isMounted) {
      for (const p of this.panel.scope.querySelectorAll('.c2md-para[data-active]')) {
        if (p instanceof HTMLElement) delete p.dataset.active;
      }
      const target = /** @type {HTMLElement|null} */ (
        this.panel.scope.querySelector(`.c2md-para[data-start="${Math.floor(seconds)}"]`));
      if (target) {
        target.dataset.active = 'true';
        setTimeout(() => delete target.dataset.active, 1600);
      }
    }
    return true;
  }

  markdown() {
    return markdownOf(this.doc, this.settings);
  }

  plainText() {
    return plainTextOf(this.meta, this.built?.sections ?? this.liveSections, this.settings);
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
      const bundle = imageBundle(this.doc, this.previewSections, this.settings);
      if (bundle) {
        return await send({ type: 'file.saveBundle', payload: { folder: this.doc.meta.title, ...bundle } });
      }
      return await send({ type: 'file.save', payload: { filename: fileNameFor(this.doc.meta.title, 'md'), text: this.markdown() } });
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
      if (this.meta && (this.built || this.liveSections) && previousLevel !== this.settings.imageLevel && this.imageLevel !== this.settings.imageLevel) this.frames.refreshImages();
      this.broadcast();
    }
    return reply;
  }


  // ---------- 缓存 ----------

  /** 存最近一次的笔记。存不进去（配额满）也不算错，只是下次要重新抓。 */
  async saveCache() {
    await saveSession(sessionKey(this.adapter.id), {
      meta: this.meta,
      sections: this.built.sections,
      // 已取到的帧按时刻存，密度换挡时同款时刻直接复用
      images: [...this.imageCache.entries()],
      stats: this.built.stats,
      warnings: this.built.warnings,
      polished: this.polishState.hasResult,
    });
  }

  /** @returns {Promise<any>} キャッシュの項目（sections、stats、images など）。無ければ null */
  loadCache() {
    return loadSession(sessionKey(this.adapter.id));
  }
}

export { copyText };

export async function start() {
  const controller = new Controller();
  window.__c2mdController = controller;
  await controller.init();
  return controller;
}
