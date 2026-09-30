//! 音频容器与扩展名的小工具。
//! 内容脚本挑 MediaRecorder 的编码、后台挑上传文件名时都会用到。

/** 按优先级探测 MediaRecorder 支持的音频容器。 */
export function pickAudioMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  }
  return '';
}

/**
 * mime -> 文件扩展名。
 * @param {unknown} mime
 */
export function extensionForMime(mime) {
  const m = String(mime ?? '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('flac')) return 'flac';
  return 'webm';
}

/** 常见 ASR 服务接受的音频扩展名，用于在设置页给出提示。 */
export function supportedAudioExtensions() {
  return ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm', 'mp4'];
}
