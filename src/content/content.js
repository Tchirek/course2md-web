//! 内容脚本控制器：持有状态、跑管线、渲染面板、响应弹窗。
//!
//! 状态放在这里而不是后台，所以 service worker 被回收、弹窗被关掉、
//! 用户切走标签页，都不会影响正在进行的工作。

import { pickAdapter, siteLabel } from '../adapters/index.js';
import { toErrorState } from './errors.js';
import { Panel } from './panel.js';
import { buildDoc, fileNameFor, upstreamSnapshot } from '../core/format.js';
import { runSubtitlePipeline, runAsrPipeline, finalize, organize, MissingSourceError, AbortError } from './pipeline.js';
import { copyText, send } from './messaging.js';
import { imageBundle, markdownOf, plainTextOf } from './exporter.js';
import { loadSession, saveSession, sessionKey } from './session-cache.js';
import { PolishCoordinator } from './polish-coordinator.js';
import { FrameLoader } from './frame-loader.js';
import { ensureFreshCode, extensionGone, resumeAfterExtensionReload, takeResumeRequest } from './freshness.js';
import { TitleLauncher } from './title-launcher.js';
import { DEFAULT_SETTINGS } from '../core/settings.js';

const POLL_MS = 1500;

/** @typedef {import('../core/settings.js').Settings} Settings */
/** @typedef {import('../core/format.js').DocSection} DocSection */
/** @typedef {import('./errors.js').ErrorState} ErrorState */
/** @typedef {'idle'|'loading'|'running'|'ready'|'error'} Status */
/** @typedef {'copy'|'download'} ExportKind */
/** @typedef {{source?: string}} RunOverrides 只作用于某次生成的选择 */

/**
 * 会话缓存里存的一份笔记（saveCache 写、loadCache 读；扩展版本不同的会被丢弃）。
 * @typedef {object} CacheEntry
 * @property {import('../adapters/index.js').VideoMeta} meta
 * @property {DocSection[]} sections
 * @property {[number, string][]} [images] 讲述时刻 → 已取到的帧
 * @property {import('./pipeline.js').PipelineStats} stats
 * @property {string[]} [warnings]
 * @property {boolean} [polished]
 * @property {import('../core/model.js').TranscriptEvent[]} [originalEvents]
 */

export class Controller {
  constructor() {
    this.adapter = pickAdapter();
    // 真正的设置在 init() 里从后台读；读到之前（或后台没起来时）先用默认值
    /** @type {Settings} */
    this.settings = structuredClone(DEFAULT_SETTINGS);
    /** 当前面板与帧所用的图片密度（设置改了之后，由 FrameLoader 跟上） */
    this.imageLevel = this.settings.imageLevel;
    /** @type {import('../adapters/index.js').VideoMeta|null} */
    this.meta = null;
    /** @type {import('./pipeline.js').PipelineResult|null} */
    this.built = null;
    /** @type {(DocSection & {frames: import('../core/format.js').Frame[]})[]} 面板显示的分节（带去重后的帧） */
    this.previewSections = [];
    /** @type {import('../core/format.js').Doc|null} */
    this.doc = null;
    /** @type {Status} */
    this.status = 'idle';
    /** @type {ErrorState|null} */
    this.error = null;
    /** @type {ErrorState|null} */
    this.imageError = null;
    this.stageLabel = '';
    /** @type {number|null} */
    this.stageRatio = null;
    /** @type {AbortController|null} */
    this.abort = null;
    this.imagesPending = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.autoTimer = undefined;
    // 点过「生成笔记」后才允许切换视频自动生成；关闭浮窗即失效
    this.autoRunArmed = false;
    // 只作用于下一次生成的临时选择（如标题旁的按钮指定优先用平台字幕），不改设置
    /** @type {RunOverrides|null} */
    this.nextRunOverrides = null;
    // 自动生成（换视频时）沿用开启它的那次选择：由标题旁的 ↗ 开启的就一直优先用平台字幕
    /** @type {RunOverrides|null} */
    this.autoRunOverrides = null;
    // 内容がまだできていないときに押された複製・保存。できた瞬間に実行する（もう一度押すと取り消し）。
    // ブラウザの「ダウンロード完了後に開く」と同じ考え方
    this.pendingExport = { copy: false, download: false };
    // 実行し終えた書き出し。該当ボタンにしばらく「已复制」「已保存」を出す（両方同時に終わりうるので別々に持つ）
    this.exportFlash = { copy: false, download: false };
    /** @type {Partial<Record<ExportKind, ReturnType<typeof setTimeout>>>} */
    this.exportFlashTimers = {};
    this.panelDismissed = false;
    this.librarySaving = false;
    /** @type {import('../core/model.js').TranscriptEvent[]|null} 转录途中已到手的事件 */
    this.liveEvents = null;
    /** @type {DocSection[]|null} 转录途中先组织出来的分节 */
    this.liveSections = null;
    /** @type {string|null} 这次生成自动改用本地转录的说明 */
    this.fallbackNotice = null;
    this.urlKey = this.currentUrlKey();
    /** @type {TitleLauncher|null} */
    this.launcher = null;
    this.polisher = new PolishCoordinator(this);
    this.frames = new FrameLoader(this);

    this.panel = new Panel({
      onSettings: (patch) => this.patchSettings(patch),
      onSeek: (sec) => this.seek(sec),
      onCopy: () => this.requestExport('copy'),
      onCopyText: () => this.copyPlainText(),
      onDownload: () => this.requestExport('download'),
      onLibrary: () => this.saveLibrary(),
      onRerun: () => {
        this.autoRunArmed = true;
        this.autoRunOverrides = null;
        return this.run();
      },
      onRepolish: () => this.polisher.repolish(),
      onOptions: (section) => this.openOptions(section),
      onClose: () => this.closePanel(),
    });
  }

  // ---------- 生命周期 ----------

  async init() {
    // 后台还没起来时沿用构造时的默认值，界面不至于空白
    const loaded = await send({ type: 'settings.load' }).catch(() => null);
    if (loaded) this.settings = loaded;
    this.imageLevel = this.settings.imageLevel;

    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      // 只认自己的消息类型：不把 constructor 之类原型上的名字当成处理函数
      const handler = Object.hasOwn(this.MESSAGES, message?.type) ? this.MESSAGES[message.type] : null;
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
      this.settings = next;
      this.panel.setState({ settings: this.settings });
      if (this.meta && (this.built || this.liveSections) && this.imageLevel !== this.settings.imageLevel) this.frames.refreshImages();
      if (this.settings.showPanel && this.doc && !this.panelDismissed) this.panel.mount();
      this.polisher.settingsChanged(old, next);
    });

    // SPA 换视频：YouTube 与 B 站都是不刷新页面换内容的
    setInterval(() => this.checkNavigation(), POLL_MS);

    this.launcher = new TitleLauncher(() => this.adapter.id, () => this.launch());
    this.launcher.start();

    // 有缓存内容就恢复出来（后退/前进回来时不用重新抓一遍）
    const cacheGeneration = this.frames.generation;
    const cached = await this.loadCache();
    if (this.frames.generation !== cacheGeneration) return;
    if (cached) {
      this.built = {
        sections: cached.sections,
        segments: cached.sections.flatMap((section) => section.segments),
        sectionIndexOf: cached.sections.flatMap((section, i) => section.segments.map(() => i)),
        stats: cached.stats,
        warnings: cached.warnings ?? [],
        originalEvents: cached.originalEvents,
      };
      this.built.segments.forEach((seg, id) => { seg.id = id; });
      for (const [t, image] of cached.images ?? []) {
        await this.frames.remember(t, image);
        if (this.frames.generation !== cacheGeneration) return;
      }
      this.meta = cached.meta;
      this.doc = buildDoc({ ...this.meta, source: cached.stats.source }, cached.sections);
      this.status = 'ready';
      this.polisher.restore(Boolean(cached.polished));
      this.frames.present();
      if (this.settings.showPanel) this.panel.mount();
      if (this.imagesPending) this.frames.refreshImages();
    }
    this.broadcast();

    // 扩展重新加载时没做完的生成：页面刷新后接着做
    const resume = takeResumeRequest(this.urlKey);
    if (resume) {
      this.nextRunOverrides = resume.overrides ?? null;
      this.autoRunOverrides = this.nextRunOverrides;
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
    this.frames.cancel();
    this.polisher.cancel();
    clearTimeout(this.autoTimer);
    this.urlKey = key;
    this.pendingExport = { copy: false, download: false };
    // 换视频了：清干净，避免把上一个视频的笔记留在屏幕上
    this.adapter = pickAdapter();
    this.built = null;
    this.previewSections = [];
    this.frames.reset();
    this.imagesPending = false;
    this.doc = null;
    this.meta = null;
    // 已武装自动生成：直接进入「加载中」占位（与本地模型转录一致），
    // 不让「暂无笔记」在启动的一秒空窗里闪出来
    this.status = this.autoRunArmed ? 'loading' : 'idle';
    this.error = null;
    this.liveEvents = null;
    this.liveSections = null;
    this.panel.setState(this.panelState());
    if (this.autoRunArmed) this.scheduleAutoRun();
  }

  scheduleAutoRun() {
    const key = this.urlKey;
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      if (this.urlKey !== key || !this.autoRunArmed) return;
      if (!this.adapter.video()) return this.scheduleAutoRun();
      this.nextRunOverrides ??= this.autoRunOverrides;
      this.run();
    }, 1000);
  }

  // ---------- 消息 ----------

  // 载荷来自弹窗等扩展页面，按 any 接收
  /** @type {Record<string, (payload: any) => unknown>} */
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
      this.autoRunOverrides = null;
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
      polish: { ...this.polisher.progress },
      error: this.error,
      // 自動切り替えの知らせは、文字起こしの途中や失敗時にも見えるようにする（完成後は built.warnings にある）
      warnings: this.built?.warnings ?? (this.fallbackNotice ? [this.fallbackNotice] : []),
      stageLabel: this.stageLabel,
      stageRatio: this.stageRatio,
      imagesPending: this.imagesPending,
    };
  }

  panelState() {
    return {
      ...this.summaryState(),
      error: this.error || this.imageError,
      sections: this.previewSections,
      exportReady: this.exportReady(),
      exportBusy: this.exportBusy(),
      pendingExport: { ...this.pendingExport },
      exportFlash: { ...this.exportFlash },
    };
  }

  broadcast(updatePanel = true) {
    this.flushPendingExport();
    this.launcher?.setBusy(this.status === 'running');
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

  /**
   * @param {string} stage
   * @param {import('./pipeline.js').ProgressInfo} [info]
   */
  onProgress(stage, info = {}) {
    if (info.message) this.stageLabel = info.message;
    const ratio = info.ratio;
    this.stageRatio = typeof ratio === 'number' && Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : null;
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
    this.frames.cancel();
    this.polisher.begin();
    this.abort = new AbortController();
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
    this.liveEvents = null;
    this.liveSections = null;
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

      /** @type {import('./pipeline.js').PipelineArgs} */
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
          // 润色不必等转录全部结束
          this.polisher.onPartial(events);
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
      // 下一行的取帧会广播状态，预约的导出可能就此触发：先声明收尾，让导出等润色
      this.polisher.prepareFinish();

      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      this.frames.refreshImages();
      if (runAbort.signal.aborted) throw new AbortError();

      // 勾了润色且配置齐全，就在同一次流程里顺带跑掉
      await this.polisher.finish(runAbort);
      if (runAbort.signal.aborted) throw new AbortError();

      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      await this.saveCache();
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
    this.polisher.afterRun();
    this.broadcast();
    return { status: this.status, error: this.error };
  }


  /**
   * 标题旁的 ↗：立即生成。这一次优先用平台字幕（没有就照常自动改用本地转录），
   * 图片密度沿用上次停留的挡位（即设置里的 imageLevel）。正在生成时只把面板叫出来。
   */
  launch() {
    this.panelDismissed = false;
    if (this.status === 'running') {
      this.panel.mount();
      this.broadcast();
      return;
    }
    this.autoRunArmed = true;
    this.autoRunOverrides = { source: 'subtitle' };
    this.nextRunOverrides = this.autoRunOverrides;
    this.run().catch((error) => {
      this.status = 'error';
      this.error = toErrorState(error);
      this.broadcast();
    });
  }

  /**
   * 扩展正在重新加载：面板说明缘由，扩展起来后刷新页面、接着生成。
   * @param {RunOverrides} overrides
   */
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
    this.frames.cancel();
    this.polisher.stop();
    this.status = 'idle';
    this.stageLabel = '';
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.broadcast();
    return { cancelled: true };
  }

  // ---------- 动作 ----------

  /** @param {number} seconds */
  async seek(seconds) {
    const ok = await this.adapter.seek(seconds).catch(() => false);
    if (!ok) return false;
    // 短暂标一下当前段落，用户回到页面时知道跳到哪了
    const scope = this.panel.scope;
    if (this.panel.isMounted && scope) {
      for (const p of scope.querySelectorAll('.c2md-para[data-active]')) {
        if (p instanceof HTMLElement) delete p.dataset.active;
      }
      const target = /** @type {HTMLElement|null} */ (
        scope.querySelector(`.c2md-para[data-start="${Math.floor(seconds)}"]`));
      if (target) {
        target.dataset.active = 'true';
        setTimeout(() => delete target.dataset.active, 1600);
      }
    }
    return true;
  }

  markdown() {
    return markdownOf(this.doc, this.settings, this.built?.sections ?? this.doc?.sections);
  }

  plainText() {
    return plainTextOf(this.meta, this.built?.sections ?? this.liveSections, this.settings);
  }

  /** 今すぐ書き出せるか：成稿があり、添える画像もそろっている。 */
  exportReady() {
    return this.status === 'ready' && Boolean(this.doc) &&
      !(this.imagesPending && this.settings.imageLevel !== 'none');
  }

  /** まだ内容を作っている最中か（文字起こし・画像取得・润色）。この間の書き出しは予約になる。 */
  exportBusy() {
    if (this.status === 'running' || this.status === 'loading') return true;
    return this.status === 'ready' && (!this.exportReady() || this.polisher.busy);
  }

  /**
   * 浮窓の複製・保存：書き出せるならすぐ実行、作成中なら「完了後に実行」を切り替える。
   * @param {ExportKind} kind
   */
  async requestExport(kind) {
    if (this.exportReady()) return this.runExport(kind);
    if (!this.exportBusy()) return false;
    this.pendingExport[kind] = !this.pendingExport[kind];
    this.panel.setState(this.panelState());
    return false;
  }

  /** @param {ExportKind} kind */
  async runExport(kind) {
    const ok = kind === 'copy' ? await this.copyMarkdown() : (await this.download())?.saved !== false;
    if (ok) {
      this.exportFlash[kind] = true;
      clearTimeout(this.exportFlashTimers[kind]);
      this.exportFlashTimers[kind] = setTimeout(() => {
        this.exportFlash[kind] = false;
        this.panel.setState(this.panelState());
      }, 1800);
      this.panel.setState(this.panelState());
    }
    return ok;
  }

  /** 状態が変わるたびに確かめる：予約が実行できるなら実行し、失敗・取り消しなら破棄する。 */
  flushPendingExport() {
    const kinds = /** @type {('copy'|'download')[]} */ (['copy', 'download']).filter((kind) => this.pendingExport[kind]);
    if (!kinds.length) return;
    if (this.status === 'error' || this.status === 'idle') {
      this.pendingExport = { copy: false, download: false };
      return;
    }
    // 润色の終了までを「完了」とみなす。そうしないと润色前の稿を複製してしまう
    if (!this.exportReady() || this.exportBusy()) return;
    this.pendingExport = { copy: false, download: false };
    for (const kind of kinds) this.runExport(kind);
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

  async saveLibrary() {
    if (!this.doc || this.librarySaving) return;
    if (!this.exportReady() || this.exportBusy()) return;
    const { selectedLibrary } = await chrome.storage.local.get('selectedLibrary');
    if (typeof selectedLibrary !== 'string' || !selectedLibrary) {
      await send({ type: 'ui.openLibrary' });
      return;
    }
    this.librarySaving = true;
    try {
      const doc = { ...this.doc, meta: { ...this.doc.meta, polished: Boolean(this.settings.polish && this.polisher.progress.hasResult),
        showTimestamps: this.settings.showTimestamps, imageLevel: this.settings.imageLevel } };
      const sections = this.settings.imageLevel === 'none'
        ? (this.built?.sections ?? this.doc.sections).map((s) => ({ ...s, frames: [] })) : this.previewSections;
      const snapshot = upstreamSnapshot(doc, sections);
      const input = { ...snapshot, library: selectedLibrary, events: this.built?.originalEvents ?? [] };
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
      const requestId = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const value = await send({ type: 'library.request', payload: { action: 'publish', input: {
        ...input, requestId,
      } } });
      const params = new URLSearchParams({ library: selectedLibrary, course: value.course, version: value.version });
      await send({ type: 'ui.openLibrary', payload: { query: params.toString() } });
    } catch (error) {
      this.error = toErrorState(error);
      this.panel.setState(this.panelState());
    } finally { this.librarySaving = false; }
  }


  /** @param {string} [section] 设置页要打开的分区 */
  async openOptions(section) {
    return send({ type: 'ui.openOptions', payload: { section } });
  }

  /** @param {object} patch 要改的设置（只含改动的字段） */
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
    if (!this.built) return;
    await saveSession(sessionKey(this.adapter.id), {
      meta: this.meta,
      sections: this.built.sections,
      // 已取到的帧按时刻存，密度换挡时同款时刻直接复用
      images: [...this.frames.cache.entries()],
      stats: this.built.stats,
      warnings: this.built.warnings,
      polished: this.polisher.progress.hasResult,
      originalEvents: this.built.originalEvents,
    });
  }

  /** @returns {Promise<CacheEntry|null>} 没有、过期或版本不同时为 null */
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
