import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
globalThis.window = { addEventListener() {} };
const { tracks } = await import('../src/adapters/bilibili.js');
const { downloadBilibiliVideo } = await import('../tools/bilibili-audio.mjs');

const v = (number) => {
  const bytes = [];
  while (number > 127) { bytes.push((number % 128) | 128); number = Math.floor(number / 128); }
  return Uint8Array.from([...bytes, number]);
};
const field = (number, value) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Uint8Array.from([...v(number * 8 + 2), ...v(bytes.length), ...bytes]);
};

test('B 站旧接口无字幕时读取新版 AI 字幕，并补齐 aid/cid', async () => {
  const original = globalThis.fetch;
  const item = Uint8Array.from([...field(3, 'ai-zh'), ...field(4, '中文 AI'), ...field(5, '//example.com/subtitle.json')]);
  const proto = field(1, field(3, item));
  const calls = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/x/web-interface/view') return { ok: true, json: async () => ({ data: { aid: 12, cid: 34, pages: [{ cid: 34 }, { cid: 56 }] } }) };
    if (path === '/x/v2/subtitle/web/view') return { ok: true, arrayBuffer: async () => proto.buffer };
    return { ok: true, json: async () => ({ code: 0, data: { subtitle: { subtitles: [] } } }) };
  };
  try {
    const result = await tracks({ videoId: 'BVtest', url: 'https://www.bilibili.com/video/BVtest?p=2' });
    assert.equal(result.length, 1);
    assert.equal(result[0].language, 'ai-zh');
    assert.equal(result[0].fetch.url, 'https://example.com/subtitle.json');
    assert.ok(calls.includes('/x/v2/subtitle/web/view'));
  } finally { globalThis.fetch = original; }
});

test('B 站已加载的 AI 字幕地址可作为接口失效时的备用轨道', async () => {
  const originalFetch = globalThis.fetch;
  const originalPerformance = globalThis.performance;
  globalThis.performance = { getEntriesByType: () => [{ name: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1234.json' }] };
  globalThis.fetch = async () => ({ json: async () => ({ code: 0, data: { subtitle: { subtitles: [] } } }), ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
  try {
    const result = await tracks({ videoId: 'BVtest', aid: 12, cid: 34, url: 'https://www.bilibili.com/video/BVtest' });
    assert.equal(result.length, 1);
    assert.equal(result[0].fetch.url, 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1234.json');
  } finally { globalThis.fetch = originalFetch; globalThis.performance = originalPerformance; }
});

test('B 站字幕接口携带 aid/cid，字幕文件跨域失败时走扩展后台', async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/x/web-interface/view')) return { ok: true, json: async () => ({ data: { aid: 12, cid: 34, pages: [{ cid: 34 }] } }) };
    if (String(url).includes('/x/player/v2')) return { ok: true, json: async () => ({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://aisubtitle.hdslb.com/sub.json' }] } } }) };
    throw new TypeError('Failed to fetch');
  };
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true, value: JSON.stringify({ body: [{ from: 0, to: 1, content: '测试字幕' }] }) }) } };
  try {
    const found = await tracks({ videoId: 'BVtest', url: 'https://www.bilibili.com/video/BVtest' });
    assert.match(requests.find((url) => url.includes('/x/player/v2')), /aid=12&cid=34/);
    const { readTrack } = await import('../src/adapters/index.js');
    assert.equal((await readTrack(found[0]))[0].text, '测试字幕');
  } finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
});

test('取画面先尝试 B 站备用 CDN，主线路 SSL 失败不再交给 yt-dlp', async () => {
  const originalFetch = globalThis.fetch;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'c2md-video-test-'));
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    if (host === 'api.bilibili.com' && url.includes('/view?')) return new Response(JSON.stringify({ code: 0, data: { cid: 34, pages: [{ cid: 34 }] } }));
    if (host === 'api.bilibili.com') return new Response(JSON.stringify({ code: 0, data: { dash: { video: [{ bandwidth: 1, backupUrl: ['https://bad.example/video', 'https://good.example/video'], baseUrl: 'https://main.example/video' }] } } }));
    if (host === 'bad.example') throw new Error('EOF occurred in violation of protocol');
    if (host === 'good.example') return new Response('video bytes');
    throw new Error(`意外请求 ${host}`);
  };
  try {
    const file = await downloadBilibiliVideo(new URL('https://www.bilibili.com/video/BV1BbKw6XEWq'), dir, new AbortController().signal);
    assert.equal(await readFile(file, 'utf8'), 'video bytes');
  } finally {
    globalThis.fetch = originalFetch;
    assert(dir.startsWith(path.join(os.tmpdir(), 'c2md-video-test-')));
    await rm(dir, { recursive: true, force: true });
  }
});
