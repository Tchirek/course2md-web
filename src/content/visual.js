// 图片密度只决定「每个分节取哪些帧时刻」，绝不重新分节：
// 显示结构（章节分节与段落）是稳定不变的，密度切换不会搬动任何段落，
// 浏览器的原生滚动锚定才能始终锚在段落上。帧时刻落在段落的起始时间上，
// 呈现时图片插在它对应的段落之前。
/**
 * @template {import('../core/format.js').DocSection} S
 * @param {S[]} sections
 * @param {string} [level] none / few / default / many
 * @param {Map<number, string>} [cache] 讲述时刻 → 已取到的图
 * @returns {(S & {frames: Frame[]})[]}
 */
export function attachFrames(sections, level = 'default', cache = new Map()) {
  if (level === 'none') return sections.map((section) => ({ ...section, frames: [] }));
  const step = /** @type {Record<string, number>} */ ({ few: 180, default: 60, many: 10 })[level] ?? 60;
  const catalogue = [...cache.keys()].sort((a, b) => a - b);
  return sections.map((section, index) => {
    /** @type {Frame[]} */
    const frames = [];
    let slot = -1;
    const times = cache.size
      ? catalogue.filter((t) => t >= (index ? section.t ?? 0 : 0) && t < (sections[index + 1]?.t ?? Infinity))
      : section.segments.map((segment) => segment.start);
    for (const t of times) {
      const nextSlot = Math.floor(Math.max(0, t - (section.t ?? 0)) / step);
      if (nextSlot !== slot) {
        slot = nextSlot;
        frames.push({ t, image: cache.get(t) ?? '' });
      }
    }
    return { ...section, frames };
  });
}

/** @typedef {import('../core/format.js').Frame} Frame */

/**
 * Consume the CLI's frame catalogue at its actual timestamps.
 * @param {import('../adapters/index.js').VideoMeta} meta
 * @param {AbortSignal} [signal]
 * @param {(frame: Frame) => Promise<void>|void} [onImage]
 * @returns {Promise<number>} 取到的张数
 */
export async function captureSectionImages(meta, signal, onImage) {
  const started = await chrome.runtime.sendMessage({ type: 'frame.start', payload: { sourceUrl: meta.url, title: meta.title, duration: meta.duration, uploader: meta.uploader } });
  if (!started?.ok || !started.value?.id) throw new Error(started?.error ?? '本机取帧服务不可用');
  const id = started.value.id;
  let seen = 0;
  let kept = 0;
  try {
    while (!signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const reply = await chrome.runtime.sendMessage({ type: 'frame.status', payload: { id, after: seen } });
      if (!reply?.ok) throw new Error(reply?.error ?? '本机取帧失败');
      const job = reply.value;
      for (const frame of job.images ?? []) {
        kept++;
        await onImage?.({ t: frame.time, image: frame.data });
      }
      seen += job.images?.length ?? 0;
      if (job.state === 'done' && seen >= (job.imagesTotal ?? seen)) return kept;
      if (job.state === 'error') throw new Error(job.error);
    }
    return kept;
  } finally {
    if (signal?.aborted) chrome.runtime.sendMessage({ type: 'frame.cancel', payload: { id } }).catch(() => {});
  }
}
