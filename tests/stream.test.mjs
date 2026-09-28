import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../src/background/llm.js';
import { DEFAULT_INSTRUCTION, instructionFor } from '../src/core/prompt.js';
import { Converter } from '../src/vendor/opencc-t2cn.js';

test('流式润色按 SSE 增量交付，CRLF 和拆包不丢字', async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"第二段"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 41));
      controller.enqueue(bytes.slice(41, 83));
      controller.enqueue(bytes.slice(83));
      controller.close();
    },
  }));
  try {
    const deltas = [];
    const result = await chat({ baseUrl: 'http://localhost/v1', model: 'm', messages: [], onDelta: (x) => deltas.push(x) });
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
  try {
    const result = await polishSegments({
      segments, sectionIndexOf: [0, 0], meta: {},
      settings: { polishLevel: 'standard', llm: { baseUrl: 'http://localhost/v1', model: 'm', concurrency: 1, contextChars: 0 } },
      onSegment: (id) => updated.push([id, segments[id].text]),
    });
    assert.equal(result.failed, 0);
    assert.deepEqual(updated, [[0, '第一段。'], [1, '第二段。']]);
    assert.equal(segments[0].raw, '第一段');
  } finally {
    globalThis.chrome = originalChrome;
  }
});
