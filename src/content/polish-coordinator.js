//! 整形（润色）の段取り：本番の整形、転写中の先行整形、本機整形サービスの起動待ち、再整形。
//! 润色的状态（进度、中止、提前润色的批次、收尾阶段、待重润）归这里所有；控制器只调用下面的动作，
//! 不再直接读写这些字段。

import { useLocalPolish, LOCAL_POLISH } from '../core/settings.js';
import { polishProgress } from '../core/prompt.js';
import { toErrorState } from './errors.js';
import { send } from './messaging.js';
import { polishSegments, finalize, eventSectionIndexOf, AbortError } from './pipeline.js';

/** @typedef {import('../core/settings.js').Settings} Settings */

/** 提前润色起步的最少事件数：攒够一点内容就开始，不等转录全部结束。 */
export const EARLY_POLISH_MIN_EVENTS = 12;

/**
 * 润色进度：done / total 是已润色内容与视频的时长（秒），hasResult 表示已有润色过的段落。
 * @typedef {{hasResult: boolean, running: boolean, done: number, total: number}} PolishProgress
 */

/** @returns {PolishProgress} */
const idleProgress = () => ({ hasResult: false, running: false, done: 0, total: 0 });
const idleEarly = () => ({ active: false, done: false, promise: /** @type {Promise<void>|null} */ (null), covered: 0 });

export class PolishCoordinator {
  /** @param {import('./content.js').Controller} controller */
  constructor(controller) {
    this.c = controller;
    /** 面板上的润色进度（圆环与「已润色」标记） */
    this.progress = idleProgress();
    /** @type {AbortController|null} 润色专用的中止：取消勾选只停润色，不停整次生成 */
    this.abort = null;
    /** 转录进行中提前润色的批次 */
    this.early = idleEarly();
    /** 生成的收尾阶段（等提前润色、正式润色）：此时的导出要等它结束 */
    this.finalizing = false;
    /** 收尾或润色进行中改了润色设置：做完这一轮再按新设置润一遍 */
    this.restartPending = false;
  }

  /** 新的一次生成：停掉旧的润色，状态清零。 */
  begin() {
    this.abort?.abort();
    this.abort = new AbortController();
    this.reset();
  }

  /** 换视频：停掉润色，状态清零。 */
  cancel() {
    this.abort?.abort();
    this.reset();
  }

  /** 只停手头的润色（用户取消了生成），已完成的段落保留。 */
  stop() {
    this.abort?.abort();
  }

  reset() {
    this.progress = idleProgress();
    this.early = idleEarly();
    this.finalizing = false;
    this.restartPending = false;
  }

  /**
   * 从会话缓存恢复的笔记是否带着润色结果。
   * @param {boolean} hasResult
   */
  restore(hasResult) {
    this.progress.hasResult = hasResult;
  }

  /** 润色还在进行（含收尾阶段）：导出要等。 */
  get busy() {
    return this.progress.running || this.finalizing;
  }

  /**
   * 转录进行中又到了一批事件：攒够量就先润一批，上一批落定后接着推进。
   * @param {import('../core/model.js').TranscriptEvent[]} events
   */
  onPartial(events) {
    const batchDue = events.length - (this.early.covered ?? 0) >= EARLY_POLISH_MIN_EVENTS;
    const batchFree = !this.early.active && ((this.early.covered ?? 0) === 0 || this.early.done);
    if (this.c.settings.polish && this.polishReady() && batchDue && batchFree) this.startEarlyPolish(events);
  }

  /**
   * 润色相关的设置变了（控制器已换上新设置之后调用）。
   * 开了润色或换了模型：笔记已成就重润；正在收尾或润色就排队重润；转录中途就把提前润色接上。
   * 关了润色：停掉手头的润色，已完成的段落保留。
   * @param {Settings} old
   * @param {Settings} next
   */
  settingsChanged(old, next) {
    const configChanged = next.polishLevel !== old.polishLevel ||
      next.polishEngine !== old.polishEngine ||
      next.llm?.baseUrl !== old.llm?.baseUrl || next.llm?.model !== old.llm?.model;
    const wanted = next.polish && (!old.polish || configChanged);
    if (old.polish && !next.polish && this.progress.running) this.abort?.abort();
    const live = this.c.liveEvents;
    if (this.c.built && wanted) {
      if (this.finalizing || this.progress.running) this.restartPending = true;
      else this.repolish({ reset: configChanged });
    } else if (!this.c.built && wanted && this.c.status === 'running' && !this.early.active && !this.early.done &&
      live && live.length >= EARLY_POLISH_MIN_EVENTS) {
      this.startEarlyPolish(live);
    }
  }

  /** 进入生成的收尾阶段：从这一刻起导出要等润色结束（在任何可能触发导出的广播之前调用）。 */
  prepareFinish() {
    this.finalizing = true;
  }

  /**
   * 生成的收尾：先等提前润色落定，再续润没润过的段落；期间设置又变了就按新设置再来一遍。
   * @param {AbortController} runAbort 这次生成的中止
   */
  async finish(runAbort) {
    if (!this.c.settings.polish) return;
    if (this.early.promise) await this.early.promise.catch(() => {});
    if (runAbort.signal.aborted) throw new AbortError();
    do {
      this.restartPending = false;
      try {
        await this.runPolish({ resume: true });
      } catch (error) {
        if (runAbort.signal.aborted) throw error;
        if (!(error instanceof AbortError)) this.c.error = toErrorState(error);
      }
    } while (this.c.settings.polish && this.restartPending && !runAbort.signal.aborted);
  }

  /** 生成结束（成功、失败或取消）：离开收尾阶段；收尾期间排队的重润现在开始。 */
  afterRun() {
    this.finalizing = false;
    if (this.restartPending && this.c.settings.polish && this.c.built && !this.progress.running) {
      this.restartPending = false;
      this.repolish();
    }
  }

  /**
   * 跑一遍润色。
   * @param {object} [options]
   * @param {import('../core/model.js').Segment[]} [options.segments] 要润色的段落（默认 this.c.built.segments；提前润色时传事件列表）
   * @param {number[]} [options.sectionIndexOf] 段落下标 -> 章节下标
   * @param {boolean} [options.resume] 续润：跳过已润色的段落
   * @param {boolean} [options.early] 转录尚未结束的提前润色：不触碰面板正文
   */
  async runPolish(options = {}) {
    const { resume = false, early = false } = options;
    const segments = options.segments ?? this.c.built?.segments;
    const sectionIndexOf = options.sectionIndexOf ?? this.c.built?.sectionIndexOf;
    if (!segments?.length) return;
    if (!this.abort || this.abort.signal.aborted) this.abort = new AbortController();
    const polishAbort = this.abort;
    const runAbort = this.c.abort;
    const signal = AbortSignal.any(runAbort ? [polishAbort.signal, runAbort.signal] : [polishAbort.signal]);
    this.progress = { hasResult: this.progress.hasResult, running: true, done: 0, total: 0 };
    this.c.panel.setState({ polish: this.progress });
    try {
    const useLocal = useLocalPolish(this.c.settings);
    if (this.c.settings.polishEngine === 'custom' && (!this.c.settings.llm.baseUrl || !this.c.settings.llm.model)) {
      throw new Error('请先填写自定义模型的服务地址和模型名');
    }
    const polishSettings = useLocal ? await this.localPolishSettings(signal) : this.c.settings;
    const result = await polishSegments({
      segments,
      sectionIndexOf,
      // 元信息只作提示用；万一还没有也照样润色
      meta: this.c.meta ?? {},
      settings: polishSettings,
      signal,
      resume,
      // 自备 LLM 三次都失败时，静默换成本机润色
      fallback: useLocal ? undefined : { ensure: () => this.ensureLocalPolish(signal) },
      onProgress: () => {
        if (signal.aborted) return;
        // 分母是视频总时长，恒定不变；分子是已润色内容的时长，圆环只进不退
        this.progress = { ...this.progress, running: true, ...polishProgress(segments, this.c.meta?.duration) };
        this.c.panel.setState({ polish: this.progress });
        this.c.broadcast(false);
      },
      onSegment: (id) => {
        if (signal.aborted) return;
        this.progress.hasResult = true;
        if (!early && this.c.built?.segments?.[id]) this.c.panel.updateSegment(this.c.built.segments[id]);
      },
      onReset: () => {
        if (signal.aborted) return;
        if (!early) this.c.panel.setState({ sections: this.c.previewSections });
      },
    });

    if (signal.aborted) throw new AbortError();

    const built = this.c.built;
    if (result.failed && !early) {
      built?.warnings.push(`润色失败 ${result.failed}/${result.chunks}：${result.firstError || '模型未返回可用文本'}`);
    }
    this.progress = { hasResult: true, running: false, ...polishProgress(segments, this.c.meta?.duration) };
    if (!early && built && this.c.meta) {
      this.c.doc = finalize(built, this.c.meta, this.c.settings);
      await this.c.saveCache();
    }
    } finally {
      // An old request can finish after navigation or a new run starts.
      if (this.abort === polishAbort && this.c.abort === runAbort) {
        this.progress.running = false;
        this.c.panel.setState({ polish: this.progress });
      }
    }
  }

  /**
   * 提前润色：转录还在进行时就润已经到手的事件；事件对象就地更新。
   * @param {import('../core/model.js').TranscriptEvent[]} events
   */
  startEarlyPolish(events) {
    const early = this.early;
    early.active = true;
    early.covered = events.length;
    early.promise = this.runPolish({
      segments: events,
      sectionIndexOf: eventSectionIndexOf(events, this.c.meta),
      resume: true,
      early: true,
    })
      .then(() => { early.done = true; })
      .catch(() => {})
      .finally(() => { early.active = false; });
  }

  /** 润色是否具备启动条件（自定义模型未配置时不提前开跑）。 */
  polishReady() {
    return useLocalPolish(this.c.settings) ||
      !(this.c.settings.polishEngine === 'custom' && (!this.c.settings.llm.baseUrl || !this.c.settings.llm.model));
  }

  /** 本机润色的 LLM 配置（沿用术语表与自定义指令）。 */
  localPolishLlm() {
    return { ...this.c.settings.llm, ...LOCAL_POLISH, concurrency: 1 };
  }

  /**
   * 启动本机润色服务并等它就绪；启动进度照常显示。
   * @param {AbortSignal} signal
   * @returns {Promise<Settings>}
   */
  async localPolishSettings(signal) {
    await this.waitLocalPolish(signal, (message) => {
      if (signal.aborted) return;
      this.c.stageLabel = message;
      this.c.broadcast();
    });
    if (signal.aborted) throw new AbortError();
    this.c.stageLabel = '';
    return { ...this.c.settings, llm: this.localPolishLlm() };
  }

  /** 静默确保本机润色可用：不打扰进度显示，只在失败时抛错。 */
  /** @param {AbortSignal} signal */
  async ensureLocalPolish(signal) {
    await this.waitLocalPolish(signal);
    return this.localPolishLlm();
  }

  /**
   * @param {AbortSignal} [signal]
   * @param {(message:string) => void} [onState]
   */
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

  /** @param {{reset?: boolean}} [options] reset：从头重润，而不是续润 */
  async repolish(options = {}) {
    if (!this.c.built) return { status: 'none' };
    if (!this.abort || this.abort.signal.aborted) this.abort = new AbortController();
    this.progress = { ...this.progress, running: true };
    this.c.panel.setState(this.c.panelState());
    try {
      // 默认续润（跳过已润色的段落）；设置变了才从头再来
      do {
        this.restartPending = false;
        try {
          await this.runPolish({ resume: !options.reset });
        } catch (error) {
          if (!(error instanceof AbortError) || !this.c.settings.polish || !this.restartPending) throw error;
        }
        options.reset = false;
      } while (this.c.settings.polish && this.restartPending);
      this.c.error = null;
    } catch (error) {
      this.progress.running = false;
      if (!(error instanceof AbortError)) this.c.error = toErrorState(error);
    }
    this.c.broadcast();
    return { status: 'done' };
  }
}
