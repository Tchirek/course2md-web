//! 本機モデルによる文字起こしの流れ：本機助手での高速抽出、ブラウザでのオフライン復号、再生録音の順に試す。

import { fmtTs } from '../core/time.js';
import { MissingSourceError, AbortError } from '../core/errors.js';
import { captureAudio } from './capture.js';
import { decodeMediaAudio, FastAudioUnavailable } from './fast-audio.js';
import { organize, simplifyBilibili } from './organize.js';

/**
 * 用本机模型转录音频再组织成文档。
 *
 * @param {import('./pipeline.js').PipelineArgs} args
 * @returns {Promise<import('./pipeline.js').PipelineResult>}
 */
export async function runAsrPipeline({ adapter, meta, settings, onProgress, onPartial, signal }) {
  /** @type {string[]} */
  const warnings = [];
  const asr = settings.asr;

  const el = adapter.video();
  if (!el) throw new MissingSourceError('页面上找不到 video 元素，无法转录。');

  if (!asr.endpoint) {
    throw new MissingSourceError(
      '还没填写本机 ASR 服务的地址。到设置页的「本地模型转录」里填一个端点——' +
        'whisper.cpp 的 server、faster-whisper-server 都行，音频不出本机。',
    );
  }

  if (/^https?:\/\/(?:127\.0\.0\.1|localhost):8081\/v1\/audio\/transcriptions\/?$/.test(asr.endpoint)) {
    onProgress?.('capture', { ratio: 0, message: '正在启动本机转录服务' });
    const started = await chrome.runtime.sendMessage({ type: 'asr.local.start' });
    if (!started?.ok) throw new Error(started?.error ?? '本机转录服务启动失败');
    if (started.value?.state === 'error') throw new Error(started.value.message);
  }

  /** @type {import('../core/model.js').TranscriptEvent[]} */
  const events = [];
  let fastError = '';
  if (/^(https?:|file:)/.test(meta.url || '')) {
    onProgress?.('capture', { ratio: 0, message: '正在尝试本机快速提取音轨' });
    let fastJobId;
    try {
      const started = await chrome.runtime.sendMessage({
        type: 'asr.fast.start',
        payload: {
          sourceUrl: meta.url,
          endpoint: asr.endpoint,
          apiKey: asr.apiKey,
          model: asr.model,
          prompt: meta.title,
          language: asr.language || meta.language || undefined,
          chunkSeconds: asr.chunkSeconds,
        },
      });
      if (!started?.ok || !started.value?.id) throw new Error(started?.error ?? '本机提取未启动');
      fastJobId = started.value.id;
      let job;
      let seen = 0;
      do {
        if (signal?.aborted) throw new AbortError();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const reply = await chrome.runtime.sendMessage({ type: 'asr.fast.status', payload: { id: started.value.id, after: seen } });
        if (!reply?.ok) throw new Error(reply?.error ?? '本机任务查询失败');
        job = reply.value;
        if (job.events?.length) {
          await simplifyBilibili(job.events, adapter.id);
          events.push(...job.events);
          seen += job.events.length;
          onPartial?.(events);
        }
        onProgress?.('capture', { ratio: job.total ? job.done / job.total : 0, message: job.message });
      } while (job.state === 'running');
      if (job.state === 'error') throw new Error(job.error);
      // Notes from the helper (e.g. it finished on the CPU after a GPU error) become panel notices
      for (const note of job.warnings ?? []) if (!warnings.includes(note)) warnings.push(note);
      if (events.length) {
        await simplifyBilibili(events, adapter.id);
        const built = organize(events, meta, {});
        return {
          ...built,
          stats: {
            source: 'asr',
            trackLabel: `${asr.model || '本机模型'} · 本机快速提取`,
            eventCount: events.length,
            chunkCount: job.chunks,
            captureMode: 'local-helper',
          },
          warnings,
        };
      }
    } catch (error) {
      if (signal?.aborted || error instanceof AbortError) {
        if (fastJobId) chrome.runtime.sendMessage({ type: 'asr.fast.cancel', payload: { id: fastJobId } }).catch(() => {});
        throw new AbortError();
      }
      fastError = String(/** @type {{message?: string}} */ (error)?.message ?? error);
      warnings.push(`本机快速提取失败：${fastError}`);
      if (events.length) {
        events.length = 0;
        onPartial?.(events);
      }
      // 没运行辅助服务时继续尝试浏览器可读媒体。
    }
  }
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  /** @type {unknown} 最先失败的那一片的错误，之后的切片不再送出 */
  let failure = null;
  /** @type {import('./capture.js').CaptureOptions} */
  const options = {
    chunkSeconds: asr.chunkSeconds,
    playbackRate: asr.playbackRate,
    signal,
    onProgress: (info) => onProgress?.('capture', { ...info, message: '正在提取并转写音频' }),
    onChunk: async (chunk, index) => {
      if (failure) throw failure;
      const task = chrome.runtime.sendMessage({
        type: 'asr.transcribe',
        payload: {
          endpoint: asr.endpoint,
          apiKey: asr.apiKey,
          model: asr.model,
          prompt: meta.title,
          language: asr.language || meta.language || undefined,
          audio: bytesToBase64(new Uint8Array(await chunk.blob.arrayBuffer())),
          mimeType: chunk.blob.type,
          fileName: `chunk-${String(index).padStart(4, '0')}.${chunk.extension}`,
        },
      }).then(async (reply) => {
        if (!reply?.ok || !reply.value?.ok) {
          const detail = reply?.error ?? reply?.value?.error ?? '未知错误';
          throw new Error(`第 ${index} 片转写失败：${detail}`);
        }
        const value = reply.value;
        if (value.segments?.length) {
          for (const s of value.segments) {
            events.push({ start: chunk.start + s.start, end: chunk.start + s.end, text: s.text });
          }
        } else if (value.text) {
          events.push({ start: chunk.start, end: chunk.end, text: value.text });
        }
        await simplifyBilibili(events, adapter.id);
        onPartial?.(events);
      }).catch((error) => { failure ??= error; }).finally(() => pending.delete(task));
      pending.add(task);
      if (pending.size >= 2) await Promise.race(pending);
      if (failure) throw failure;
    },
  };

  onProgress?.('capture', { ratio: 0, message: '正在离线读取音频' });
  let result;
  try {
    result = await decodeMediaAudio(el, options);
  } catch (error) {
    if (!(error instanceof FastAudioUnavailable)) throw error;
    if (fastError) {
      throw new MissingSourceError(`本机音轨提取失败：${fastError}\n浏览器也无法离线读取：${error.message}`);
    }
    const totalSec = Number(meta.duration) || Number(el.duration) || 0;
    warnings.push(`无法离线读取媒体（${error.message}），改用播放器录音。${totalSec ? `约需 ${fmtTs(totalSec / Math.max(1, asr.playbackRate))}。` : ''}`);
    onProgress?.('capture', { ratio: 0, message: '媒体无法离线读取，正在录音' });
    result = await captureAudio(el, options);
  }
  await Promise.all(pending);
  if (failure) throw failure;

  if (result.aborted) throw new AbortError();
  if (!events.length) {
    throw new MissingSourceError('转录没有产出任何文字。确认视频有声音，且本机 ASR 服务工作正常。');
  }

  await simplifyBilibili(events, adapter.id);
  const built = organize(events, meta, {});
  return {
    ...built,
    stats: {
      source: 'asr',
      trackLabel: asr.model || '本机模型',
      eventCount: events.length,
      capturedSeconds: result.seconds,
      chunkCount: result.chunks,
      captureMode: result.mode ?? 'realtime',
    },
    warnings,
  };
}

/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
