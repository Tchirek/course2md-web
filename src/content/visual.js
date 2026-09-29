// 图片密度只决定「每个分节取哪些帧时刻」，绝不重新分节：
// 显示结构（章节分节与段落）是稳定不变的，密度切换不会搬动任何段落，
// 浏览器的原生滚动锚定才能始终锚在段落上。帧时刻落在段落的起始时间上，
// 呈现时图片插在它对应的段落之前。
export function attachFrames(sections, level = 'default', cache = new Map()) {
  if (level === 'none') return sections.map((section) => ({ ...section, frames: [] }));
  const step = { few: 180, default: 60, many: 10 }[level] ?? 60;
  return sections.map((section) => {
    const frames = [];
    let slot = -1;
    for (const segment of section.segments) {
      const nextSlot = Math.floor(Math.max(0, segment.start - (section.t ?? 0)) / step);
      if (nextSlot !== slot) {
        slot = nextSlot;
        frames.push({ t: segment.start, image: cache.get(segment.start) ?? '' });
      }
    }
    return { ...section, frames };
  });
}

export async function captureSectionImages(sourceUrl, frames, signal, onImage) {
  const times = frames.map((frame) => frame.t);
  if (!times.length) return 0;
  const started = await chrome.runtime.sendMessage({ type: 'frame.start', payload: { sourceUrl, times } });
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
        const item = frames.find((candidate) => candidate.t === frame.time);
        if (item) {
          item.image = frame.data;
          kept++;
          onImage?.(item);
        }
      }
      seen += job.images?.length ?? 0;
      if (job.state === 'done') return kept;
      if (job.state === 'error') throw new Error(job.error);
    }
    return kept;
  } finally {
    if (signal?.aborted) chrome.runtime.sendMessage({ type: 'frame.cancel', payload: { id } }).catch(() => {});
  }
}
