import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
const { tracks } = await import('../src/adapters/bilibili.js');

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
    if (path === '/x/web-interface/view') return { json: async () => ({ data: { aid: 12, cid: 34, pages: [{ cid: 34 }, { cid: 56 }] } }) };
    if (path === '/x/v2/subtitle/web/view') return { ok: true, arrayBuffer: async () => proto.buffer };
    return { json: async () => ({ code: 0, data: { subtitle: { subtitles: [] } } }) };
  };
  try {
    const result = await tracks({ videoId: 'BVtest', url: 'https://www.bilibili.com/video/BVtest?p=2' });
    assert.equal(result.length, 1);
    assert.equal(result[0].language, 'ai-zh');
    assert.equal(result[0].fetch.url, 'https://example.com/subtitle.json');
    assert.ok(calls.includes('/x/v2/subtitle/web/view'));
  } finally { globalThis.fetch = original; }
});
