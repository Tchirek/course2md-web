// 面板按可读的画面段落展示；原始章节留给 Markdown 导出。
export function visualSections(sections, duration) {
  const step = Math.max(90, Math.ceil((Number(duration) || 0) / 24 / 30) * 30);
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

export async function captureSectionImages(video, sections, host, signal) {
  if (!video || !sections.length || !Number.isFinite(video.duration)) return;
  const original = { time: video.currentTime, paused: video.paused };
  const wasHidden = host?.style.visibility;
  try {
    video.pause();
    if (host) host.style.visibility = 'hidden';
    for (const section of sections) {
      if (signal?.aborted) break;
      const time = Math.min(video.duration - 0.2, Math.max(0, section.t + 0.5));
      if (!(time >= 0)) continue;
      try {
        await seekFrame(video, time);
        section.image = await frameImage(video);
      } catch {
        // 受 DRM、跨域或标签页切换限制的画面没有图；文字仍可用。
      }
    }
  } finally {
    try { video.currentTime = original.time; } catch {}
    if (!original.paused) video.play().catch(() => {});
    if (host) host.style.visibility = wasHidden ?? '';
  }
}

function seekFrame(video, time) {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.05 && video.readyState >= 2) return resolve();
    const timer = setTimeout(() => done(false), 2500);
    const done = (ok) => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      ok ? resolve() : reject(new Error('画面定位超时'));
    };
    const onSeeked = () => done(true);
    video.addEventListener('seeked', onSeeked, { once: true });
    try { video.currentTime = time; } catch { done(false); }
  });
}

async function frameImage(video) {
  const width = 480;
  const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
  if (!video.videoWidth || !video.videoHeight) throw new Error('无画面');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  try {
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    // 跨域视频会污染 canvas。扩展已有 activeTab 权限，可截当前可见标签页。
    await new Promise((resolve) => setTimeout(resolve, 550));
    const reply = await chrome.runtime.sendMessage({ type: 'frame.visible' });
    if (!reply?.ok || !reply.value) throw new Error('无法截取标签页');
    const image = new Image();
    image.src = reply.value;
    await image.decode();
    const rect = video.getBoundingClientRect();
    const scale = image.naturalWidth / innerWidth;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const sx = left * scale;
    const sy = top * scale;
    const sw = (Math.min(innerWidth, rect.right) - left) * scale;
    const sh = (Math.min(innerHeight, rect.bottom) - top) * scale;
    if (sw <= 0 || sh <= 0) throw new Error('画面不在视口内');
    canvas.width = width;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.72);
  }
}
