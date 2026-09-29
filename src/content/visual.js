// 图片只取有讲述的时间窗；最多每 10 秒一张，与原版的最短保存间隔一致。
export function visualSections(sections, _duration, level = 'default') {
  if (level === 'none') return sections.map((section) => ({ ...section, image: '' }));
  const step = { few: 180, default: 60, many: 10 }[level] ?? 60;
  const out = [];
  for (const section of sections) {
    let group = null;
    let slot = -1;
    let first = true;
    for (const segment of section.segments) {
      const nextSlot = Math.floor(Math.max(0, segment.start - section.t) / step);
      if (!group || nextSlot !== slot) {
        slot = nextSlot;
        group = { t: segment.start, title: first ? section.title : '', segments: [] };
        out.push(group);
        first = false;
      }
      group.segments.push(segment);
    }
  }
  return out;
}

export async function captureSectionImages(sourceUrl, sections, signal, onImage) {
  const times = sections.filter((section) => !section.captured).map((section) => section.t);
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
        const section = sections.find((item) => item.t === frame.time);
        if (section) {
          section.image = frame.data;
          kept++;
          onImage?.(section);
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
