//! 本地模型转录：把音频切片发给本机的 OpenAI 兼容转写端点。
//!
//! 面向用户本机已经在跑的任一种服务：
//!   - whisper.cpp 的 server（`./server -m ggml-base.bin`）
//!   - faster-whisper-server / speaches
//!   - Ollama 之外的任何 `/v1/audio/transcriptions` 实现
//! 端点地址、模型名、可选的 API key 都由用户自己填，插件不预设任何云服务。

const REQUEST_TIMEOUT_MS = 300_000;

/**
 * 转写一段音频。
 *
 * 优先要 `verbose_json`：它带 `segments[].start/end`，能给出句级时间戳，
 * 这样「显示时刻 / 点击跳转」在本地转录下也照样成立。
 * 服务端不支持时退回 `json`，调用方会用切片的时间窗兜底（见 parseAsrResponse）。
 *
 * @param {object} args
 * @param {string} args.endpoint
 * @param {string} [args.apiKey]
 * @param {string} args.model
 * @param {string} [args.language]
 * @param {ArrayBuffer|Uint8Array} args.audio
 * @param {string} [args.mimeType]
 * @param {string} [args.fileName]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ok:true, data:object}|{ok:false, error:string, hint?:string}>}
 */
export async function transcribe({
  endpoint,
  apiKey,
  model,
  language,
  audio,
  mimeType = 'audio/webm',
  fileName = 'chunk.webm',
  signal,
}) {
  const url = String(endpoint ?? '').trim();
  if (!url) return { ok: false, error: '还没填写本机 ASR 端点地址。' };

  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  if (!bytes.byteLength) return { ok: false, error: '音频切片是空的。' };

  const attempt = async (responseFormat) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), fileName);
    form.append('model', model || 'whisper-1');
    form.append('response_format', responseFormat);
    form.append('temperature', '0');
    if (language) form.append('language', language);

    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await withTimeout(
      fetch(url, { method: 'POST', headers, body: form, signal }),
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) {
      const detail = await readError(res);
      const err = new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  try {
    return { ok: true, data: await attempt('verbose_json') };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: '已取消' };
    // 400/422 多半是服务端不认识 verbose_json，退回 json 再试一次
    if (err?.status === 400 || err?.status === 422) {
      try {
        return { ok: true, data: await attempt('json') };
      } catch (retryErr) {
        return { ok: false, error: describe(retryErr, url), hint: connectionHint(url) };
      }
    }
    return { ok: false, error: describe(err, url), hint: connectionHint(url) };
  }
}

/** 把一次转写响应变成可用的结果；拿不到 segments 就交给调用方兜底。 */
export function parseAsrResponse(data) {
  if (!data || typeof data !== 'object') return { text: '', segments: [] };

  if (Array.isArray(data.segments) && data.segments.length) {
    const segments = data.segments
      .map((s) => {
        const start = Number(s?.start);
        const end = Number(s?.end);
        const text = String(s?.text ?? '').trim();
        if (!text || !Number.isFinite(start)) return null;
        return { start, end: Number.isFinite(end) && end >= start ? end : start, text };
      })
      .filter(Boolean);
    if (segments.length) return { text: segments.map((s) => s.text).join(' '), segments };
  }

  return { text: String(data.text ?? '').trim(), segments: [] };
}

/** 本机服务的连通性探测。设置页的「测试连接」用它。 */
export async function testEndpoint({ endpoint, apiKey, model }) {
  const url = String(endpoint ?? '').trim();
  if (!url) return { ok: false, message: '还没填写端点地址。' };

  // 先试着读模型列表；读不到不算错，直接发 0.3 秒的静音去实测
  try {
    const base = url.replace(/\/audio\/transcriptions\/?$/, '');
    const res = await withTimeout(
      fetch(`${base}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }),
      10_000,
    );
    if (res.ok) {
      const json = await res.json();
      const ids = (json?.data ?? []).map((m) => m?.id).filter(Boolean);
      if (ids.length) {
        return {
          ok: true,
          message: `服务在跑，列出了 ${ids.length} 个模型${model && !ids.includes(model) ? `，但没有「${model}」` : ''}。`,
          models: ids,
        };
      }
      return { ok: true, message: '服务在跑。' };
    }
  } catch {
    /* 继续实测 */
  }

  // /models 不响应很正常（whisper.cpp 的 server 就没有），改用真实请求实测：
  // 发 0.1 秒的静音 WAV。WAV 头好构造，且各家的服务都收。
  const probe = await transcribe({
    endpoint: url,
    apiKey,
    model,
    audio: silentWav(0.1),
    mimeType: 'audio/wav',
    fileName: 'probe.wav',
  });
  if (probe.ok) return { ok: true, message: '转写请求成功，服务可用。' };
  return { ok: false, message: probe.error, hint: probe.hint };
}

/** 生成一段 16kHz / 单声道 / 16bit 的静音 WAV，用于连通性实测。 */
export function silentWav(seconds = 0.1, sampleRate = 16000) {
  const samples = Math.max(1, Math.floor(seconds * sampleRate));
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt 块长度
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true);           // 块对齐
  view.setUint16(34, 16, true);          // 位深
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  // 采样区保持全 0，就是静音

  return new Uint8Array(buffer);
}

function describe(err, url) {
  const message = String(err?.message ?? err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return `连不上 ${url}。确认本机服务已在运行，且地址与端口正确。`;
  }
  return message;
}

function connectionHint(url) {
  return (
    `请确认 ${url} 对应的服务正在运行。` +
    `whisper.cpp 用 ./server -m <模型> 启动（默认 8080 端口，路径 /v1/audio/transcriptions）；` +
    `faster-whisper-server 默认 8000 端口。`
  );
}

async function readError(res) {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const json = JSON.parse(text);
      const msg = json?.error?.message ?? json?.error ?? json?.detail ?? json?.message;
      if (typeof msg === 'string') return msg.slice(0, 300);
    } catch {
      /* 用原文 */
    }
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('请求超时');
      err.name = 'AbortError';
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
