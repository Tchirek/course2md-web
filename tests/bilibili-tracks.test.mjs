import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
const { tracks } = await import('../src/adapters/bilibili.js');
const { MissingSourceError } = await import('../src/core/errors.js');

const v = (number) => {
  const bytes = [];
  while (number > 127) { bytes.push((number % 128) | 128); number = Math.floor(number / 128); }
  return Uint8Array.from([...bytes, number]);
};
const field = (number, value) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Uint8Array.from([...v(number * 8 + 2), ...v(bytes.length), ...bytes]);
};

test('B 站播放器接口无字幕且需登录时给出指引，不再调用内容归属不明的字幕接口', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const path = new URL(u).pathname;
    if (path === '/x/web-interface/view') return { ok: true, json: async () => ({ data: { aid: 12, cid: 34, pages: [{ cid: 34 }, { cid: 56 }] } }) };
    return { ok: true, json: async () => ({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }) };
  };
  try {
    await assert.rejects(
      tracks({ videoId: 'BVtest', url: 'https://www.bilibili.com/video/BVtest?p=2' }),
      (error) => error instanceof MissingSourceError && error.message.includes('登录'),
    );
    // 字幕リクエストはパートの cid で補う（p=2 → cid=56）。帰属を検証できない Protobuf 接口には決して落ちない
    const playerUrl = calls.find((u) => new URL(u).pathname === '/x/player/wbi/v2');
    assert.ok(playerUrl, 'wbi/v2 を呼ぶこと');
    assert.equal(new URL(playerUrl).searchParams.get('cid'), '56');
    assert.ok(calls.some((u) => new URL(u).pathname === '/x/v2/subtitle/web/view') === false, '不得调用加密分发的字幕接口');
  } finally { globalThis.fetch = original; }
});

test('B 站の字幕は wbi/v2 だけから取り、/x/player/v2 もページに残った字幕 URL も使わない', async () => {
  const originalFetch = globalThis.fetch;
  const originalPerformance = globalThis.performance;
  const calls = [];
  // パスは本動画の aid+cid でも、/x/player/v2 由来の auth_key は他動画の字幕を指し得る
  globalThis.performance = { getEntriesByType: () => [{ name: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1234stale?auth_key=x' }] };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const path = new URL(String(url)).pathname;
    const subtitles = path === '/x/player/v2' ? [{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/wrong' }] : [];
    return { ok: true, json: async () => ({ code: 0, data: { subtitle: { subtitles } } }) };
  };
  try {
    const result = await tracks({ videoId: 'BVtest', aid: 12, cid: 34, url: 'https://www.bilibili.com/video/BVtest' });
    assert.deepEqual(result, []);
    assert.ok(calls.some((u) => new URL(u).pathname === '/x/player/wbi/v2'));
    assert.ok(!calls.some((u) => new URL(u).pathname === '/x/player/v2'), '字幕に /x/player/v2 を使わないこと');
  } finally { globalThis.fetch = originalFetch; globalThis.performance = originalPerformance; }
});

test('B 站字幕接口に届かないときは「字幕なし」ではなく接口不通として報告する', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === '/x/web-interface/view') return { ok: true, json: async () => ({ data: { aid: 12, cid: 34 } }) };
    throw new TypeError('Failed to fetch');
  };
  try {
    await assert.rejects(
      tracks({ videoId: 'BVtest', url: 'https://www.bilibili.com/video/BVtest' }),
      (error) => error instanceof MissingSourceError && error.message.includes('接口暂时不可用') && error.message.includes('Failed to fetch'),
    );
  } finally { globalThis.fetch = originalFetch; }
});

test('B 站字幕接口携带 aid/cid，字幕文件跨域失败时走扩展后台', async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/x/web-interface/view')) return { ok: true, json: async () => ({ data: { aid: 12, cid: 34, pages: [{ cid: 34 }] } }) };
    if (String(url).includes('/x/player/wbi/v2')) return { ok: true, json: async () => ({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://aisubtitle.hdslb.com/sub.json' }] } } }) };
    throw new TypeError('Failed to fetch');
  };
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true, value: JSON.stringify({ body: [{ from: 0, to: 1, content: '测试字幕' }] }) }) } };
  try {
    const found = await tracks({ videoId: 'BVtest', url: 'https://www.bilibili.com/video/BVtest' });
    const player = new URL(requests.find((url) => url.includes('/x/player/wbi/v2')));
    assert.equal(player.searchParams.get('aid'), '12');
    assert.equal(player.searchParams.get('cid'), '34');
    const { readTrack } = await import('../src/adapters/index.js');
    assert.equal((await readTrack(found[0]))[0].text, '测试字幕');
  } finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
});

test('時間軸が動画の長さに収まらない字幕は別動画のものとして拒否する', async () => {
  const { runSubtitlePipeline } = await import('../src/content/pipeline.js');
  const cues = (end) => [{ start: 0, end: 2, text: '开头' }, { start: end - 2, end, text: '结尾' }];
  const run = (end) => runSubtitlePipeline({
    adapter: { id: 'bilibili', tracks: async () => [{ id: 'a', language: 'ai-zh', label: '中文', kind: 'automatic', inlineCues: cues(end) }] },
    meta: { duration: 607, title: 't', url: 'https://www.bilibili.com/video/BVtest' },
    settings: { subtitle: { preferLang: 'zh', allowAuto: true } },
  });
  await assert.rejects(run(1114), (error) => error instanceof MissingSourceError && error.message.includes('疑似其他视频的字幕'));
  assert.equal((await run(600)).stats.eventCount, 2);
});
