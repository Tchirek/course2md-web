//! 整形（润色）の段取り：本番の整形、転写中の先行整形、本機整形サービスの起動待ち、再整形。
//! 状態はコントローラが持ち、ここはそれを読み書きする。

import { useLocalPolish, LOCAL_POLISH } from '../core/settings.js';
import { polishProgress } from '../core/prompt.js';
import { toErrorState } from './errors.js';
import { send } from './messaging.js';
import { polishSegments, finalize, eventSectionIndexOf, AbortError } from './pipeline.js';

export class PolishCoordinator {
  /** @param {import('./content.js').Controller} controller */
  constructor(controller) {
    this.c = controller;
  }

  /**
   * 跑一遍润色。
   * @param {object} [options]
   * @param {object[]} [options.segments] 要润色的段落（默认 this.c.built.segments；提前润色时传事件列表）
   * @param {number[]} [options.sectionIndexOf] 段落下标 -> 章节下标
   * @param {boolean} [options.resume] 续润：跳过已润色的段落
   * @param {boolean} [options.early] 转录尚未结束的提前润色：不触碰面板正文
   */
  async runPolish(options = {}) {
    const { resume = false, early = false } = options;
    const segments = options.segments ?? this.c.built?.segments;
    const sectionIndexOf = options.sectionIndexOf ?? this.c.built?.sectionIndexOf;
    if (!segments?.length) return;
    if (!this.c.polishAbort || this.c.polishAbort.signal.aborted) this.c.polishAbort = new AbortController();
    const polishAbort = this.c.polishAbort;
    const runAbort = this.c.abort;
    const signal = AbortSignal.any([this.c.polishAbort.signal, this.c.abort?.signal].filter(Boolean));
    this.c.polishState = { hasResult: this.c.polishState.hasResult, running: true, done: 0, total: 0 };
    this.c.panel.setState({ polish: this.c.polishState });
    try {
    const useLocal = useLocalPolish(this.c.settings);
    if (this.c.settings.polishEngine === 'custom' && (!this.c.settings.llm.baseUrl || !this.c.settings.llm.model)) {
      throw new Error('请先填写自定义模型的服务地址和模型名');
    }
    const polishSettings = useLocal ? await this.localPolishSettings(signal) : this.c.settings;
    const result = await polishSegments({
      segments,
      sectionIndexOf,
      meta: this.c.meta,
      settings: polishSettings,
      signal,
      resume,
      // 自备 LLM 三次都失败时，静默换成本机润色
      fallback: useLocal ? undefined : { ensure: () => this.ensureLocalPolish(signal) },
      onProgress: () => {
        if (signal.aborted) return;
        // 分母是视频总时长，恒定不变；分子是已润色内容的时长，圆环只进不退
        this.c.polishState = { ...this.c.polishState, running: true, ...polishProgress(segments, this.c.meta?.duration) };
        this.c.panel.setState({ polish: this.c.polishState });
        this.c.broadcast(false);
      },
      onSegment: (id) => {
        if (signal.aborted) return;
        this.c.polishState.hasResult = true;
        if (!early && this.c.built?.segments?.[id]) this.c.panel.updateSegment(this.c.built.segments[id]);
      },
      onReset: () => {
        if (signal.aborted) return;
        if (!early) this.c.panel.setState({ sections: this.c.previewSections });
      },
    });

    if (signal.aborted) throw new AbortError();

    if (result.failed && !early) {
      this.c.built.warnings.push(`润色失败 ${result.failed}/${result.chunks}：${result.firstError || '模型未返回可用文本'}`);
    }
    this.c.polishState = { hasResult: true, running: false, ...polishProgress(segments, this.c.meta?.duration) };
    if (!early) {
      this.c.doc = finalize(this.c.built, this.c.meta, this.c.settings);
      await this.c.saveCache();
    }
    } finally {
      // An old request can finish after navigation or a new run starts.
      if (this.c.polishAbort === polishAbort && this.c.abort === runAbort) {
        this.c.polishState.running = false;
        this.c.panel.setState({ polish: this.c.polishState });
      }
    }
  }

  /** 提前润色：转录还在进行时就润已经到手的事件；事件对象就地更新。 */
  startEarlyPolish(events) {
    const early = this.c.earlyPolish;
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

  /** 启动本机润色服务并等它就绪；启动进度照常显示。 */
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

  async repolish(options = {}) {
    if (!this.c.built) return { status: 'none' };
    if (!this.c.polishAbort || this.c.polishAbort.signal.aborted) this.c.polishAbort = new AbortController();
    this.c.polishState = { ...this.c.polishState, running: true };
    this.c.panel.setState(this.c.panelState());
    try {
      // 默认续润（跳过已润色的段落）；设置变了才从头再来
      do {
        this.c.polishRestart = false;
        try {
          await this.runPolish({ resume: !options.reset });
        } catch (error) {
          if (!(error instanceof AbortError) || !this.c.settings.polish || !this.c.polishRestart) throw error;
        }
        options.reset = false;
      } while (this.c.settings.polish && this.c.polishRestart);
      this.c.error = null;
    } catch (error) {
      this.c.polishState.running = false;
      if (!(error instanceof AbortError)) this.c.error = toErrorState(error);
    }
    this.c.broadcast();
    return { status: 'done' };
  }
}
