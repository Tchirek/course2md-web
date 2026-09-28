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
import { cookieFileFor } from './cookies.js';

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

const HANDLERS = {
  'settings.load': () => loadSettings(),
  'settings.save': (payload) => saveSettings(payload.patch ?? {}),
  'settings.reset': () => resetSettings(),

  'llm.chat': (payload) => chat(payload),
  'llm.test': (payload) => testLlm(payload),

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
  'asr.fast.start': async (payload) => {
    const probe = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(700) });
    if (!probe.ok) throw new Error('本机提取服务不可用');
    let cookieFile = '';
    try {
      const url = new URL(payload.sourceUrl);
      if (/^(?:www\.)?(?:youtube|bilibili)\.com$/.test(url.hostname)) {
        cookieFile = cookieFileFor(url.href, await chrome.cookies.getAll({ url: url.href }));
      }
    } catch { /* 未登录或站点权限尚未生效，仍尝试公开媒体 */ }
    const result = await fetch('http://127.0.0.1:8765/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, cookieFile }),
    });
    const value = await result.json();
    if (!result.ok) throw new Error(value.error ?? '本机提取失败');
    return value;
  },
  'asr.fast.status': async ({ id }) => {
    const result = await fetch(`http://127.0.0.1:8765/jobs/${encodeURIComponent(id)}`);
    const value = await result.json();
    if (!result.ok) throw new Error(value.error ?? '本机任务查询失败');
    return value;
  },
  'asr.fast.cancel': async ({ id }) => {
    await fetch(`http://127.0.0.1:8765/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { cancelled: true };
  },

  'file.save': (payload) => saveFile(payload),
  'frame.visible': async (_payload, _message, sender) => {
    if (!sender.tab?.active) throw new Error('视频标签页已切到后台');
    return chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 75 });
  },

  /** 打开设置页（弹窗里的链接用，避免弹窗内嵌 options）。 */
  'ui.openOptions': (payload) => {
    const hash = payload.section ? `#${payload.section}` : '';
    chrome.runtime.openOptionsPage();
    return { opened: true, hash };
  },

  'audio.extensions': () => supportedAudioExtensions(),
};

async function localAsr(action) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:8765/asr/${action}`, {
      method: action === 'start' ? 'POST' : 'GET',
      signal: AbortSignal.timeout(1200),
    });
  } catch {
    throw new Error('本机助手未运行。先在项目目录运行 npm run local:install。');
  }
  if (!response.ok) throw new Error(`本机助手返回 HTTP ${response.status}`);
  return response.json();
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
