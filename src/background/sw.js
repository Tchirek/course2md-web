//! 服务 worker：消息路由 + 跨域请求代理 + 下载。
//!
//! 职责刻意收得很窄——它只做内容脚本做不了的三件事：
//!  1. 发不受页面 CSP 约束的跨域请求（LLM、本机 ASR）；
//!  2. 读写设置（chrome.storage 的统一入口）；
//!  3. 保存文件（chrome.downloads）。
//! 转录的编排、分段、润色策略全部在内容脚本里，后台不持有任务状态，
//! 因此 service worker 被回收也不会丢进度。

import { loadSettings, saveSettings, resetSettings } from './store.js';
import { chat, testConnection as testLlm } from './llm.js';
import { transcribe, testEndpoint as testAsr, parseAsrResponse } from './asr.js';
import { supportedAudioExtensions } from '../core/audio-ext.js';
import { cookieFileFor, cookieHeaderFor } from './cookies.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(message.payload ?? {}, message, sender))
    .then(
      (value) => sendResponse({ ok: true, value }),
      (error) => sendResponse({ ok: false, error: describeError(error) }),
    );
  // 返回 true 表示会异步 sendResponse
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'llm.stream') return;
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());
  const post = (message) => { try { port.postMessage(message); } catch { /* 页面已离开 */ } };
  port.onMessage.addListener(async (payload) => {
    try {
      const reply = await chat({ ...payload, signal: abort.signal, onDelta: (delta) => post({ delta }) });
      post({ done: true, ...reply });
    } catch (error) {
      post({ done: true, ok: false, error: describeError(error) });
    }
  });
});

const HANDLERS = {
  'settings.load': () => loadSettings(),
  'settings.save': (payload) => saveSettings(payload.patch ?? {}),
  'settings.reset': () => resetSettings(),

  'llm.chat': (payload) => chat(payload),
  'llm.test': (payload) => testLlm(payload),
  'subtitle.fetch': async ({ url, binary = false }) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !(/(^|\.)bilibili\.com$/.test(parsed.hostname) || /(^|\.)hdslb\.com$/.test(parsed.hostname))) {
      throw new Error('字幕地址不受支持');
    }
    // MV3 后台 fetch 受跨源 SameSite 规则约束，SESSDATA 可能不随请求发出，
    // 已登录也会被 B 站判成未登录（need_login_subtitle → 字幕为空）。
    // 用户已授权直接读 cookie：像 yutto 一样显式自备登录态，不赌浏览器行为。
    const cookies = await chrome.cookies.getAll({ url: parsed.href }).catch(() => []);
    const login = cookieHeaderFor(parsed.href, cookies);
    const response = await fetch(parsed.href, {
      credentials: 'include',
      headers: login ? { Accept: '*/*', Cookie: login } : { Accept: '*/*' },
    });
    if (!response.ok) throw new Error(`取字幕失败（HTTP ${response.status}）`);
    return binary ? [...new Uint8Array(await response.arrayBuffer())] : response.text();
  },

  'asr.transcribe': async (payload) => {
    const result = await transcribe({
      ...payload,
      audio: toBytes(payload.audio),
    });
    if (!result.ok) return { ok: false, error: result.error, hint: result.hint };
    return { ok: true, ...parseAsrResponse(result.data), raw: undefined };
  },
  'asr.test': (payload) => testAsr(payload),
  'asr.local.start': () => localAsr('start'),
  'asr.local.status': () => localAsr('status'),
  'polish.local.start': () => localPolish('start'),
  'polish.local.status': () => localPolish('status'),
  'asr.fast.start': async (payload) => {
    await ensureLocalHelper();
    let cookieFile = '';
    try {
      const url = new URL(payload.sourceUrl);
      if (/^(?:www\.)?(?:youtube|bilibili)\.com$/.test(url.hostname)) {
        cookieFile = cookieFileFor(url.href, await chrome.cookies.getAll({ url: url.href }));
      }
    } catch { /* 未登录或站点权限尚未生效，仍尝试公开媒体 */ }
    const result = await fetch('http://127.0.0.1:8766/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, cookieFile }),
    });
    const value = await result.json();
    if (!result.ok) throw new Error(value.error ?? '本机提取失败');
    return value;
  },
  'asr.fast.status': async ({ id, after = 0 }) => {
    const result = await fetch(`http://127.0.0.1:8766/jobs/${encodeURIComponent(id)}?after=${Math.max(0, Number(after) || 0)}`);
    const value = await result.json();
    if (!result.ok) throw new Error(value.error ?? '本机任务查询失败');
    return value;
  },
  'asr.fast.cancel': async ({ id }) => {
    await fetch(`http://127.0.0.1:8766/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { cancelled: true };
  },
  'frame.start': async (payload) => {
    await ensureLocalHelper();
    let cookieFile = '';
    try {
      const url = new URL(payload.sourceUrl);
      if (/^(?:www\.)?(?:youtube|bilibili)\.com$/.test(url.hostname)) {
        cookieFile = cookieFileFor(url.href, await chrome.cookies.getAll({ url: url.href }));
      }
    } catch { /* 公开视频可直接尝试 */ }
    const response = await fetch('http://127.0.0.1:8766/frames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, cookieFile }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? '取帧失败');
    return value;
  },
  'frame.status': async ({ id, after = 0 }) => {
    const response = await fetch(`http://127.0.0.1:8766/jobs/${encodeURIComponent(id)}?imageAfter=${Math.max(0, Number(after) || 0)}`);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? '取帧任务失败');
    return value;
  },
  'frame.cancel': async ({ id }) => {
    await fetch(`http://127.0.0.1:8766/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { cancelled: true };
  },

  'file.save': (payload) => saveFile(payload),
  'file.saveBundle': (payload) => saveBundle(payload),
  /** 打开设置页（弹窗里的链接用，避免弹窗内嵌 options）。 */
  'ui.openOptions': async (payload) => {
    if (payload.section) {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`src/ui/options.html#${encodeURIComponent(payload.section)}`) });
    } else {
      await chrome.runtime.openOptionsPage();
    }
    return { opened: true };
  },

  'audio.extensions': () => supportedAudioExtensions(),
};

async function localAsr(action) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:8766/asr/${action}`, {
      method: action === 'start' ? 'POST' : 'GET',
      signal: AbortSignal.timeout(1200),
    });
  } catch {
    if (await wakeLocalHelper()) return localAsr(action);
    throw new Error('本机助手无法启动。请在项目目录运行 npm run local:install。');
  }
  if (!response.ok) throw new Error(`本机助手返回 HTTP ${response.status}`);
  return response.json();
}

async function localPolish(action) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:8766/polish/${action}`, {
      method: action === 'start' ? 'POST' : 'GET', signal: AbortSignal.timeout(1500),
    });
  } catch {
    if (await wakeLocalHelper()) return localPolish(action);
    throw new Error('本机助手无法启动。请在项目目录运行 npm run local:install。');
  }
  if (!response.ok) throw new Error(`本机助手返回 HTTP ${response.status}`);
  return response.json();
}

let wakingHelper;
async function ensureLocalHelper() {
  try {
    const response = await fetch('http://127.0.0.1:8766/health', { signal: AbortSignal.timeout(700) });
    if (response.ok) return;
  } catch { /* 唤醒已安装的本机宿主 */ }
  if (!await wakeLocalHelper()) throw new Error('本机助手无法启动。请在项目目录运行 npm run local:install。');
}
async function wakeLocalHelper() {
  if (wakingHelper) return wakingHelper;
  wakingHelper = new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage('com.course2md.helper', { action: 'start' }, async () => {
        if (chrome.runtime.lastError) return resolve(false);
        try {
          const response = await fetch('http://127.0.0.1:8766/health', { signal: AbortSignal.timeout(2000) });
          resolve(response.ok);
        } catch { resolve(false); }
      });
    } catch { resolve(false); }
  }).finally(() => { wakingHelper = null; });
  return wakingHelper;
}

/**
 * 保存文本文件。
 *
 * service worker 里没有 URL.createObjectURL，所以走 data: URL。
 * Markdown 是纯文本，base64 之后体积可控。
 */
async function saveFile({ filename, text, mime = 'text/markdown' }) {
  const safeName = sanitizeFilename(filename || 'notes.md');
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const url = `data:${mime};charset=utf-8;base64,${bytesToBase64(bytes)}`;

  const id = await chrome.downloads.download({
    url,
    filename: safeName,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { downloadId: id, filename: safeName };
}

export async function saveBundle({ folder, markdown, images }) {
  if (!Array.isArray(images) || !images.length || images.length > 5000) throw new Error('截图数量不正确');
  const name = `${sanitizeFilename(folder || 'course').replace(/\.md$/i, '')}-${Date.now().toString(36)}`;
  for (const [index, url] of images.entries()) {
    if (typeof url !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(url)) {
      throw new Error(`第 ${index + 1} 张截图格式错误`);
    }
    await chrome.downloads.download({
      url,
      filename: `${name}/frames/slide_${String(index + 1).padStart(4, '0')}.jpg`,
      saveAs: false,
      conflictAction: 'uniquify',
    });
  }
  const bytes = new TextEncoder().encode(String(markdown ?? ''));
  await chrome.downloads.download({
    url: `data:text/markdown;charset=utf-8;base64,${bytesToBase64(bytes)}`,
    filename: `${name}/course.md`, saveAs: false, conflictAction: 'uniquify',
  });
  return { saved: true, folder: name, images: images.length };
}

export function sanitizeFilename(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'notes.md';
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000; // 分块避免超出参数上限
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** 消息里的音频是 ArrayBuffer 或普通数组，统一成 Uint8Array。 */
function toBytes(audio) {
  if (typeof audio === 'string') return Uint8Array.from(atob(audio), (char) => char.charCodeAt(0));
  if (audio instanceof Uint8Array) return audio;
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (Array.isArray(audio)) return new Uint8Array(audio);
  if (audio?.buffer instanceof ArrayBuffer) return new Uint8Array(audio.buffer);
  return new Uint8Array(0);
}

function describeError(error) {
  const message = String(error?.message ?? error);
  return message.length > 400 ? `${message.slice(0, 400)}…` : message;
}

// 首次安装时把默认设置落盘，之后所有读取都有完整字段
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('settings');
  if (!stored?.settings) await resetSettings();
});
