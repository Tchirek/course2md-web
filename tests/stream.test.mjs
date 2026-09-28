import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../src/background/llm.js';
import { DEFAULT_INSTRUCTION, instructionFor } from '../src/core/prompt.js';
import { Converter } from '../src/vendor/opencc-t2cn.js';

test('流式润色按 SSE 增量交付，CRLF 和拆包不丢字', async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"第二段"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer custom-key');
    assert.equal(JSON.parse(options.body).model, 'custom-model');
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 41));
        controller.enqueue(bytes.slice(41, 83));
        controller.enqueue(bytes.slice(83));
        controller.close();
      },
    }));
  };
  try {
    const deltas = [];
    const result = await chat({ baseUrl: 'http://localhost/v1', apiKey: 'custom-key', model: 'custom-model', messages: [], onDelta: (x) => deltas.push(x) });
    assert.equal(result.content, '第一段第二段');
    assert.deepEqual(deltas, ['第一段', '第二段']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('标准润色提示词原样保留；B 站繁体字幕可转简体', () => {
  assert.equal(instructionFor('standard'), DEFAULT_INSTRUCTION);
  assert.equal(Converter({ from: 't', to: 'cn' })('這是一段繁體字幕。'), '这是一段繁体字幕。');
});

test('一块内逐段覆盖原文，完成前即可显示，原版仍可恢复', async () => {
  globalThis.window = { addEventListener() {} };
  const { polishSegments } = await import('../src/content/pipeline.js');
  const originalChrome = globalThis.chrome;
  const listeners = [];
  globalThis.chrome = { runtime: { connect() { return {
    onMessage: { addListener(fn) { listeners.push(fn); } },
    onDisconnect: { addListener() {} }, disconnect() {},
    postMessage() {
      listeners[0]({ delta: '{"segments":[{"id":0,"text":"第一段。"}' });
      listeners[0]({ delta: ',{"id":1,"text":"第二段。"}]}' });
      listeners[0]({ done: true, ok: true, content: '{"segments":[{"id":0,"text":"第一段。"},{"id":1,"text":"第二段。"}]}' });
    },
  }; } } };
  const segments = [
    { text: '第一段', start: 0, end: 1 },
    { text: '第二段', start: 1, end: 2 },
  ];
  const updated = [];
  const progress = [];
  try {
    const result = await polishSegments({
      segments, sectionIndexOf: [0, 0], meta: {},
      settings: { polishLevel: 'standard', llm: { baseUrl: 'http://localhost/v1', model: 'm', concurrency: 1, contextChars: 0 } },
      onSegment: (id) => updated.push([id, segments[id].text]),
      onProgress: (done, total) => progress.push([done, total]),
    });
    assert.equal(result.failed, 0);
    assert.deepEqual(updated, [[0, '第一段。'], [1, '第二段。']]);
    assert.deepEqual(progress, [[0, 1], [1, 1]]);
    assert.equal(segments[0].raw, '第一段');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

/** 造一个按调用次数脚本化的 LLM 端口。 */
function scriptedLlm(replies, calls) {
  const listeners = [];
  globalThis.chrome = { runtime: { connect() { return {
    onMessage: { addListener(fn) { listeners.push(fn); } },
    onDisconnect: { addListener() {} }, disconnect() {},
    postMessage(payload) {
      calls.push(payload);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      listeners[listeners.length - 1](reply);
    },
  }; } } };
}

const OK_CONTENT = '{"segments":[{"id":0,"text":"本机润色。"},{"id":1,"text":"第二句。"}]}';
const CUSTOM_LLM = { baseUrl: 'https://api.example.com/v1', model: 'm', concurrency: 1, contextChars: 0 };
const TWO_SEGMENTS = () => [
  { text: '第一段', start: 0, end: 1 },
  { text: '第二段', start: 1, end: 2 },
];

test('润色失败自动重试，第二次尝试成功', async () => {
  globalThis.window = { addEventListener() {} };
  const { polishSegments } = await import('../src/content/pipeline.js');
  const originalChrome = globalThis.chrome;
  const calls = [];
  scriptedLlm([
    { done: true, ok: false, error: '服务端抖了一下' },
    { done: true, ok: true, content: OK_CONTENT },
  ], calls);
  try {
    const segments = TWO_SEGMENTS();
    const result = await polishSegments({
      segments, sectionIndexOf: [0, 0], meta: {},
      settings: { polishLevel: 'standard', llm: CUSTOM_LLM },
    });
    assert.equal(result.failed, 0);
    assert.equal(calls.length, 2);
    assert.equal(segments[0].text, '本机润色。');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('自备 LLM 三次失败后静默回落本机 FireRedPunc+Qwen', async () => {
  globalThis.window = { addEventListener() {} };
  const { polishSegments } = await import('../src/content/pipeline.js');
  const originalChrome = globalThis.chrome;
  const calls = [];
  scriptedLlm([
    { done: true, ok: false, error: '自备端点 HTTP 500' },
    { done: true, ok: false, error: '自备端点 HTTP 500' },
    { done: true, ok: false, error: '自备端点 HTTP 500' },
    { done: true, ok: true, content: OK_CONTENT },
  ], calls);
  let ensured = 0;
  try {
    const segments = TWO_SEGMENTS();
    const result = await polishSegments({
      segments, sectionIndexOf: [0, 0], meta: {},
      settings: { polishLevel: 'standard', llm: CUSTOM_LLM },
      fallback: { ensure: async () => {
        ensured++;
        return { ...CUSTOM_LLM, baseUrl: 'http://127.0.0.1:8082/v1', model: 'FireRedPunc+Qwen3.5-2B' };
      } },
    });
    assert.equal(result.failed, 0);
    assert.equal(calls.length, 4);
    assert.equal(ensured, 1);
    assert.equal(calls[3].baseUrl, 'http://127.0.0.1:8082/v1');
    assert.equal(calls[3].model, 'FireRedPunc+Qwen3.5-2B');
    assert.equal(segments[1].text, '第二句。');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('本机模型失败时只重试不回落', async () => {
  globalThis.window = { addEventListener() {} };
  const { polishSegments } = await import('../src/content/pipeline.js');
  const originalChrome = globalThis.chrome;
  const calls = [];
  scriptedLlm([
    { done: true, ok: false, error: 'FireRedPunc 不可用' },
    { done: true, ok: false, error: 'FireRedPunc 不可用' },
    { done: true, ok: false, error: 'FireRedPunc 不可用' },
  ], calls);
  try {
    const segments = TWO_SEGMENTS();
    const result = await polishSegments({
      segments, sectionIndexOf: [0, 0], meta: {},
      settings: { polishLevel: 'standard', llm: { ...CUSTOM_LLM, baseUrl: 'http://127.0.0.1:8082/v1', model: 'FireRedPunc+Qwen3.5-2B' } },
    });
    assert.equal(result.failed, 1);
    assert.equal(calls.length, 3);
    assert.equal(segments[0].text, '第一段');
    assert.ok(result.firstError.includes('FireRedPunc 不可用'));
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('续润只处理未润色的段落，已润色的保留不动', async () => {
  globalThis.window = { addEventListener() {} };
  const { polishSegments } = await import('../src/content/pipeline.js');
  const originalChrome = globalThis.chrome;
  const calls = [];
  scriptedLlm([
    { done: true, ok: true, content: '{"segments":[{"id":1,"text":"续润后的第二段。"}]}' },
  ], calls);
  try {
    const segments = [
      { text: '已润色的第一段。', raw: '原第一段', start: 0, end: 1, state: 'polished' },
      { text: '第二段', start: 1, end: 2, state: 'kept' },
    ];
    const result = await polishSegments({
      segments, sectionIndexOf: [0, 0], meta: {},
      settings: { polishLevel: 'standard', llm: CUSTOM_LLM },
      resume: true,
    });
    assert.equal(result.failed, 0);
    assert.equal(calls.length, 1);
    const userContent = calls[0].messages[1].content;
    assert.ok(userContent.includes('"id":1'));
    assert.ok(!userContent.includes('"id":0'));
    assert.equal(segments[1].text, '续润后的第二段。');
    assert.equal(segments[1].raw, '第二段');
    // 已润色的段落未被重置，也没有被重新发出去
    assert.equal(segments[0].text, '已润色的第一段。');
    assert.equal(segments[0].raw, '原第一段');
    assert.equal(segments[0].state, 'polished');
  } finally {
    globalThis.chrome = originalChrome;
  }
});
