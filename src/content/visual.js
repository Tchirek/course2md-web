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
  let previous = null;
  const known = sections.filter((section) => section.image).sort((a, b) => a.t - b.t);
  let knownIndex = 0;
  try {
    while (!signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const reply = await chrome.runtime.sendMessage({ type: 'frame.status', payload: { id, after: seen } });
      if (!reply?.ok) throw new Error(reply?.error ?? '本机取帧失败');
      const job = reply.value;
      for (const frame of job.images ?? []) {
        while (knownIndex < known.length && known[knownIndex].t < frame.time) {
          previous = await thumbnail(known[knownIndex++].image);
        }
        const section = sections.find((item) => item.t === frame.time);
        if (section) {
          const current = await thumbnail(frame.data);
          section.image = previous && similarity(previous, current) >= 0.85 ? '' : frame.data;
          if (section.image) { previous = current; kept++; }
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

async function thumbnail(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 40;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, 64, 40);
  const rgba = ctx.getImageData(0, 0, 64, 40).data;
  const gray = new Float32Array(64 * 40);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
  return gray;
}
export function similarity(a, b) {
  if (a.length !== b.length || a.length !== 64 * 40) return 0;
  let total = 0;
  for (let y = 0; y < 40; y += 8) for (let x = 0; x < 64; x += 8) {
    let ma = 0, mb = 0, va = 0, vb = 0, cov = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const n = (y + j) * 64 + x + i;
      ma += a[n]; mb += b[n];
    }
    ma /= 64; mb /= 64;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const n = (y + j) * 64 + x + i;
      const da = a[n] - ma, db = b[n] - mb;
      va += da * da; vb += db * db; cov += da * db;
    }
    const c1 = 6.5025, c2 = 58.5225;
    total += ((2 * ma * mb + c1) * (2 * cov / 64 + c2)) /
      ((ma * ma + mb * mb + c1) * ((va + vb) / 64 + c2));
  }
  return total / 40;
}
