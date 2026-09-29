//! 画面（フレーム）の取得：密度に応じて各節の取得時刻を決め、本機助手から一枚ずつ受け取る。
//! 取得済みの画面・待ち行列などの状態はコントローラが持ち、ここはそれを読み書きする。

import { toErrorState } from './errors.js';
import { attachFrames, captureSectionImages } from './visual.js';

export class FrameLoader {
  /** @param {import('./content.js').Controller} controller */
  constructor(controller) {
    this.c = controller;
  }

  refreshImages() {
    const sections = this.c.built?.sections ?? this.c.liveSections;
    if (!sections || !this.c.meta) return this.c.imagePromise;
    if (this.c.imageLevel !== this.c.settings.imageLevel) {
      this.c.imageAbort?.abort();
      this.c.imageQueue.clear();
      this.c.imageInFlight.clear();
    }
    if (!this.c.imageAbort || this.c.imageAbort.signal.aborted) this.c.imageAbort = new AbortController();
    if (this.c.imageLevel !== this.c.settings.imageLevel) this.c.imageError = null;
    this.c.imageLevel = this.c.settings.imageLevel;
    // 密度只决定每个分节取哪些帧时刻，分节与段落原地不动
    this.c.previewSections = attachFrames(sections, this.c.imageLevel, this.c.imageCache);
    this.c.imagesPending = this.c.imageLevel !== 'none' &&
      this.c.previewSections.some((section) => section.frames.some((frame) => !this.c.imageCache.has(frame.t)));
    this.c.broadcast();
    if (this.c.imageLevel !== 'none' && !this.c.imageError) {
      for (const section of this.c.previewSections) {
        for (const frame of section.frames) {
          if (!this.c.imageCache.has(frame.t) && !this.c.imageQueue.has(frame.t) && !this.c.imageInFlight.has(frame.t)) {
            this.c.imageQueue.set(frame.t, frame);
          }
        }
      }
      if (!this.c.imageWorking && this.c.imageQueue.size) this.c.imagePromise = this.drainImages();
    }
    return this.c.imagePromise;
  }

  async drainImages() {
    this.c.imageWorking = true;
    const abort = this.c.imageAbort;
    const sourceUrl = this.c.meta.url;
    try {
      while (!abort.signal.aborted && this.c.imageQueue.size) {
        const batch = [...this.c.imageQueue.values()];
        this.c.imageQueue.clear();
        for (const frame of batch) this.c.imageInFlight.add(frame.t);
        try { await captureSectionImages(sourceUrl, batch, abort.signal, (frame) => {
          if (abort.signal.aborted) return;
          this.c.imageCache.set(frame.t, frame.image);
          const visible = this.c.previewSections
            .flatMap((section) => section.frames ?? [])
            .find((item) => item.t === frame.t);
          if (visible) visible.image = frame.image;
          this.c.imagesPending = this.c.imageLevel !== 'none' &&
            this.c.previewSections.some((section) => section.frames.some((item) => !this.c.imageCache.has(item.t)));
          this.c.broadcast();
        }); } finally { for (const frame of batch) this.c.imageInFlight.delete(frame.t); }
        if (this.c.built) await this.c.saveCache();
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.c.imageQueue.clear();
        this.c.imageError = toErrorState(error);
        this.c.broadcast();
      }
    } finally {
      this.c.imageWorking = false;
      if (abort.signal.aborted && this.c.imageQueue.size && this.c.imageAbort !== abort) this.c.imagePromise = this.drainImages();
    }
  }
}
