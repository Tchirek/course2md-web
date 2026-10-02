//! CLI frame catalogue, cached once per video. Density changes only presentation.
import { keepChanged } from '../core/similarity.js';
import { toErrorState } from './errors.js';
import { signatureOf } from './frame-signature.js';
import { attachFrames, captureSectionImages } from './visual.js';

export class FrameLoader {
  /** @param {import('./content.js').Controller} controller */
  constructor(controller) {
    this.c = controller;
    /** @type {AbortController|null} */
    this.abort = null;
    /** @type {Promise<unknown>} */
    this.promise = Promise.resolve();
    /** @type {'idle'|'loading'} */
    this.state = 'idle';
    /** @type {Map<number, string>} */
    this.cache = new Map();
    /** @type {Map<number, import('../core/similarity.js').Signature>} */
    this.signatures = new Map();
    this.generation = 0;
    this.complete = false;
  }

  cancel() {
    this.generation++;
    this.abort?.abort();
    this.state = 'idle';
  }

  reset() {
    this.cancel();
    this.cache.clear();
    this.signatures.clear();
    this.complete = false;
  }

  present() {
    const sections = this.c.built?.sections ?? this.c.liveSections ?? [];
    const level = this.complete && !this.cache.size ? 'none' : this.c.imageLevel;
    const candidates = attachFrames(sections, level, this.cache);
    this.c.imagesPending = this.c.imageLevel !== 'none' && !this.complete && !this.c.imageError;
    this.c.previewSections = keepChanged(candidates, this.signatures);
    return candidates;
  }

  /** @param {number} t @param {string} image */
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
    if (this.c.imageLevel !== this.c.settings.imageLevel) this.c.imageError = null;
    this.c.imageLevel = this.c.settings.imageLevel;
    if (this.c.imageLevel === 'none') this.cancel();
    this.present();
    this.c.broadcast();
    if (!this.complete && !this.c.imageError && this.c.imageLevel !== 'none' && this.state === 'idle') {
      this.abort = new AbortController();
      this.promise = this.loadImages(this.abort, this.c.meta);
    }
    return this.promise;
  }

  /** @param {AbortController} abort @param {import('../adapters/index.js').VideoMeta} meta */
  async loadImages(abort, meta) {
    this.state = 'loading';
    try {
      await captureSectionImages(meta, abort.signal, async (frame) => {
        if (abort.signal.aborted) return;
        await this.remember(frame.t, frame.image || '');
        if (abort.signal.aborted) return;
        this.present();
        this.c.broadcast();
      });
      if (!abort.signal.aborted) {
        this.complete = true;
        this.present();
        this.c.broadcast();
        if (this.c.built) await this.c.saveCache();
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.c.imageError = toErrorState(error);
        this.present();
        this.c.broadcast();
      }
    } finally {
      if (this.abort === abort) this.state = 'idle';
    }
  }
}
