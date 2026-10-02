//! 快速取音不可用时的回退：从页面上的 video 元素录音。
//!
//! 为什么不直接下音频流：YouTube 的 googlevideo 与 B 站的音频 CDN 都需要
//! 签名参数 / Referer 校验，跨域也各不相同，写死这些规则等于把插件绑在
//! 随时会变的反爬策略上。从 video 元素录制不吃任何站点规则，任何能播的
//! 视频都能转——包括用户直接在浏览器里打开的本地文件。
//!
//! 代价（都是真的，README 里也写了）：
//!   - 按真实播放速度走，1 分钟视频要 1 分钟；切片实时交给 ASR。
//!   - 录制期间视频会真的播放，且必须有音量（元素静音 => 录到的是静音）。
//!     所以这里把音量压到很低再恢复，用户几乎听不见但信号还在。
//!   - 播放倍率 > 1 会让声音变调，Whisper 的质量会掉。默认 1。

import { pickAudioMime, extensionForMime } from '../core/audio-ext.js';

/** 切片之间录制器重启的间隙；用于在进度里如实说明丢了多少。 */
const RESTART_GAP_MS = 40;

/**
 * @typedef {object} AudioChunk
 * @property {Blob} blob
 * @property {number} start 该切片在视频里的起始秒
 * @property {number} end
 * @property {string} extension
 */

/**
 * 取音的共用选项（离线解码的 fast-audio.js 也收同样的）。
 * @typedef {object} CaptureOptions
 * @property {number} chunkSeconds
 * @property {number} [playbackRate]
 * @property {AbortSignal} [signal]
 * @property {(chunk: AudioChunk, index: number) => Promise<void>|void} onChunk
 * @property {(info: {ratio:number, currentSec:number, totalSec:number}) => void} [onProgress]
 */

/**
 * 从头到尾录一遍视频的音轨，按 chunkSeconds 切片产出。
 *
 * @param {HTMLVideoElement} el
 * @param {CaptureOptions} opts
 * @returns {Promise<{chunks:number, seconds:number, aborted:boolean, mode?:string}>}
 */
export async function captureAudio(el, opts) {
  if (!el) throw new Error('页面上找不到 video 元素。');
  if (typeof el.captureStream !== 'function') {
    throw new Error('这个浏览器不支持从 video 元素捕获音轨（需要 Chrome 116+）。');
  }

  const chunkSeconds = Math.max(5, Number(opts.chunkSeconds) || 30);
  const mime = pickAudioMime();
  if (!mime) throw new Error('这个浏览器没有可用的音频录制编码。');

  const stream = el.captureStream();
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    throw new Error(
      '这个视频没有可捕获的音轨。可能是静音视频、纯画面直播，或页面用了 DRM。',
    );
  }

  const restore = {
    currentTime: el.currentTime,
    paused: el.paused,
    playbackRate: el.playbackRate,
    volume: el.volume,
    muted: el.muted,
  };

  const totalSec = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Infinity;
  let index = 0;
  let aborted = false;
  let seconds = 0;

  try {
    // 从头开始，且必须解除静音——元素静音时录到的就是静音
    el.currentTime = 0;
    el.muted = false;
    el.volume = Math.min(restore.volume, 0.04);
    el.playbackRate = Math.min(16, Math.max(1, Number(opts.playbackRate) || 1));
    await el.play();

    while (!el.ended) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      const start = el.currentTime;
      if (start >= totalSec - 0.05) break;

      const blob = await recordSlice(el, stream, mime, chunkSeconds, opts.signal);
      if (!blob || blob.size === 0) {
        if (opts.signal?.aborted) {
          aborted = true;
          break;
        }
        if (el.ended) break;
        throw new Error('播放器录音器未产出音频，已停止以免页面卡死。请使用 MizoreLink。');
      }

      const end = Math.min(el.currentTime, totalSec);
      seconds += Math.max(0, end - start);
      index++;
      await opts.onChunk?.(
        { blob, start, end, extension: extensionForMime(mime) },
        index,
      );
      opts.onProgress?.({
        ratio: Number.isFinite(totalSec) ? Math.min(1, end / totalSec) : 0,
        currentSec: end,
        totalSec,
      });
    }
  } finally {
    // 无论如何都要把播放器恢复原状，不能把用户的标签页留在奇怪状态
    for (const track of audioTracks) {
      try {
        track.stop();
      } catch {
        /* 已经停了 */
      }
    }
    try {
      el.pause();
    } catch {
      /* 忽略 */
    }
    el.muted = restore.muted;
    el.volume = restore.volume;
    el.playbackRate = restore.playbackRate;
    if (Number.isFinite(restore.currentTime)) el.currentTime = restore.currentTime;
    if (!restore.paused) {
      try {
        await el.play();
      } catch {
        /* 用户手势失效时忽略，停在暂停状态也无害 */
      }
    }
  }

  return { chunks: index, seconds, aborted };
}

/**
 * 录一片：新建一个 MediaRecorder，录够时间就停，保证每片都能独立解码。
 * @param {HTMLVideoElement} el
 * @param {MediaStream} stream
 * @param {string} mime
 * @param {number} chunkSeconds
 * @param {AbortSignal} [signal]
 * @returns {Promise<Blob|null>} 何も録れなければ null
 */
function recordSlice(el, stream, mime, chunkSeconds, signal) {
  return new Promise((resolve) => {
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64_000 });
    } catch {
      resolve(null);
      return;
    }

    /** @type {Blob[]} */
    const parts = [];
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      el.removeEventListener('ended', onEnded);
      resolve(parts.length ? new Blob(parts, { type: mime }) : null);
    };

    const stop = () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
        else finish();
      } catch {
        finish();
      }
    };

    const onAbort = () => stop();
    const onEnded = () => stop();

    recorder.ondataavailable = (event) => {
      if (event.data?.size) parts.push(event.data);
    };
    recorder.onerror = () => finish();
    recorder.onstop = () => finish();

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      recorder.start();
    } catch {
      finish();
      return;
    }
    // 视频已经播完就立刻收工，不必再等满一个切片
    timer = setTimeout(stop, chunkSeconds * 1000 + RESTART_GAP_MS);
    el.addEventListener('ended', onEnded, { once: true });
  });
}
