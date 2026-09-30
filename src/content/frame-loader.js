//! 画面（フレーム）の取得：密度に応じて各節の取得時刻を決め、本機助手から一枚ずつ受け取る。
//! FrameLoader owns the request lifetime, queue, cache and signatures.

import { keepChanged } from '../core/similarity.js';
import { toErrorState } from './errors.js';
import { signatureOf } from './frame-signature.js';
import { attachFrames, captureSectionImages } from './visual.js';

/** @typedef {import('../core/format.js').Frame} Frame */

export class FrameLoader {
  /** @param {import('./content.js').Controller} controller */
  constructor(controller) {
    this.c = controller;
    /** @type {AbortController|null} */
    this.abort = null;
    /** @type {Promise<unknown>} */
    this.promise = Promise.resolve();
    /** @type {Map<number, Frame>} 待取的帧，按讲述时刻 */
    this.queue = new Map();
    /** @type {Set<number>} 已交给本机服务、还没回来的时刻 */
    this.inFlight = new Set();
    /** @type {'idle'|'loading'} */
    this.state = 'idle';
    /** @type {Map<number, string>} 已取到的帧，按讲述时刻 */
    this.cache = new Map();
    /** @type {Map<number, import('../core/similarity.js').Signature>} */
    this.signatures = new Map();
    this.generation = 0;
  }

  cancel() {
    this.generation++;
    this.abort?.abort();
    this.queue.clear();
    this.inFlight.clear();
  }

  reset() {
    this.cancel();
    this.cache.clear();
    this.signatures.clear();
  }

  /**
   * 面板与导出看到的帧：按密度取的候选帧，去掉与上一张相似的（见 core/similarity.js）。
   * @returns {(import('../core/format.js').DocSection & {frames: Frame[]})[]} 候选帧所在的分节（未去重），供补取缺的帧
   */
  present() {
    const sections = this.c.built?.sections ?? this.c.liveSections ?? [];
    const candidates = attachFrames(sections, this.c.imageLevel, this.cache);
    this.c.imagesPending = this.c.imageLevel !== 'none' &&
      candidates.some((section) => section.frames.some((frame) => !this.cache.has(frame.t)));
    this.c.previewSections = keepChanged(candidates, this.signatures);
    return candidates;
  }

  /**
   * 记下一张取到的画面及其签名。签名先算好再显示，重复的画面不会先闪出来再消失。
   * @param {number} t
   * @param {string} image
   */
  async remember(t, image) {
    const generation = this.generation;
    const signature = await signatureOf(image).catch(() => null);
    if (generation !== this.generation) return;
    this.cache.set(t, image);
    if (signature) this.signatures.set(t, signature);
  }

  refreshImages() {
    const sections = this.c.built?.sections ?? this.c.liveSections;
    if (!sections || !this.c.meta) return this.promise;
    if (this.c.imageLevel !== this.c.settings.imageLevel) {
      this.cancel();
    }
    if (!this.abort || this.abort.signal.aborted) this.abort = new AbortController();
    const abort = this.abort;
    if (this.c.imageLevel !== this.c.settings.imageLevel) this.c.imageError = null;
    this.c.imageLevel = this.c.settings.imageLevel;
    // 密度只决定每个分节取哪些帧时刻，分节与段落原地不动
    const candidates = this.present();
    this.c.broadcast();
    if (this.c.imageLevel !== 'none' && !this.c.imageError) {
      for (const section of candidates) {
        for (const frame of section.frames) {
          if (!this.cache.has(frame.t) && !this.queue.has(frame.t) && !this.inFlight.has(frame.t)) {
            this.queue.set(frame.t, frame);
          }
        }
      }
      if (this.state === 'idle' && this.queue.size) this.promise = this.drainImages(abort);
    }
    return this.promise;
  }

  /** @param {AbortController} abort 这一轮取帧的中止（取消后若有新一轮，由新的接着取） */
  async drainImages(abort) {
    this.state = 'loading';
    const sourceUrl = this.c.meta?.url ?? '';
    try {
      while (!abort.signal.aborted && this.queue.size) {
        const batch = [...this.queue.values()];
        this.queue.clear();
        for (const frame of batch) this.inFlight.add(frame.t);
        try { await captureSectionImages(sourceUrl, batch, abort.signal, async (frame) => {
          if (abort.signal.aborted) return;
          if (frame.image) await this.remember(frame.t, frame.image);
          if (abort.signal.aborted) return;
          this.present();
          this.c.broadcast();
        }); } finally { for (const frame of batch) this.inFlight.delete(frame.t); }
        if (this.c.built) await this.c.saveCache();
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.queue.clear();
        this.c.imageError = toErrorState(error);
        this.c.broadcast();
      }
    } finally {
      this.state = 'idle';
      const next = this.abort;
      if (abort.signal.aborted && this.queue.size && next && next !== abort) this.promise = this.drainImages(next);
    }
  }
}
