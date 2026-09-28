// 可直接读取的媒体先离线解码。解码和切片按计算速度走，不依赖播放器时钟。
export class FastAudioUnavailable extends Error {}

export async function decodeMediaAudio(video, { chunkSeconds = 30, signal, onChunk, onProgress }) {
  const url = video.currentSrc || video.src;
  if (!url || !/^(https?:|blob:|file:)/.test(url)) {
    throw new FastAudioUnavailable('播放器没有可直接读取的媒体地址');
  }
  if (Number(video.duration) > 1200) {
    throw new FastAudioUnavailable('长媒体超过浏览器离线解码内存上限');
  }
  let response;
  try {
    response = await fetch(url, { credentials: 'include', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    throw new FastAudioUnavailable('浏览器无法直接读取媒体文件');
  }
  const length = Number(response.headers.get('content-length')) || 0;
  // ponytail: 整文件解码有内存上限；长媒体由本机流式服务处理更合适。
  if (length > 128 * 1024 * 1024) throw new FastAudioUnavailable('媒体文件超过离线解码上限');
  const blob = await response.blob();
  if (blob.size > 128 * 1024 * 1024) throw new FastAudioUnavailable('媒体文件超过离线解码上限');
  const context = new AudioContext();
  let audio;
  try {
    audio = await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new FastAudioUnavailable('此媒体格式无法离线解码');
  } finally {
    await context.close();
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError');
  const total = audio.duration;
  let index = 0;
  for (let start = 0; start < total;) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError');
    let end = Math.min(total, start + chunkSeconds);
    if (total - end < Math.min(5, chunkSeconds / 3)) end = total;
    const wav = wavSlice(audio, start, end);
    index++;
    await onChunk({ blob: new Blob([wav], { type: 'audio/wav' }), start, end, extension: 'wav' }, index);
    onProgress?.({ ratio: end / total, currentSec: end, totalSec: total });
    start = end;
  }
  return { chunks: index, seconds: total, aborted: false, mode: 'offline' };
}

export function wavSlice(audio, start, end) {
  const sampleRate = 16000;
  const count = Math.ceil((end - start) * sampleRate);
  const bytes = new ArrayBuffer(44 + count * 2);
  const view = new DataView(bytes);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, count * 2, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  for (let i = 0; i < count; i++) {
    const at = Math.min(audio.length - 1, Math.floor((start + i / sampleRate) * audio.sampleRate));
    const value = channels.reduce((sum, channel) => sum + channel[at], 0) / channels.length;
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true);
  }
  return bytes;
}
