import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../src/background/llm.js';
import { transcribe } from '../src/background/asr.js';

/** 本物の fetch と同じく、signal が中止されたら要求を中止理由で失敗させる偽 fetch。 */
function hangingFetch(calls) {
  return (_url, init) => {
    const call = { aborted: false };
    calls.push(call);
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      call.aborted = true;
      reject(init.signal.reason);
    }));
  };
}

const okReply = () => new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), { status: 200 });

test('期限切れの要求は下の fetch を中止し、「已取消」扱いせずに再試行する', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const hang = hangingFetch(calls);
  globalThis.fetch = (url, init) => {
    if (calls.length === 0) return hang(url, init);
    calls.push({});
    return Promise.resolve(okReply());
  };
  try {
    const result = await chat({ baseUrl: 'http://localhost/v1', model: 'm', messages: [], timeoutMs: 50 });
    assert.equal(result.ok, true);
    assert.equal(result.content, '好');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].aborted, true, '期限切れの要求が裏で走り続けてはならない');
  } finally {
    globalThis.fetch = original;
  }
});

test('利用者の取消は再試行せず「已取消」で終える', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = hangingFetch(calls);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  try {
    const result = await chat({ baseUrl: 'http://localhost/v1', model: 'm', messages: [], signal: controller.signal, timeoutMs: 5000 });
    assert.deepEqual([result.ok, result.error], [false, '已取消']);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('最後の試行が失敗したら待たずに返す（退避の待ちは試行の間だけ）', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"error":{"message":"忙"}}', { status: 503 });
  };
  try {
    const started = Date.now();
    const result = await chat({ baseUrl: 'http://localhost/v1', model: 'm', messages: [] });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(calls, 3);
    // 試行の間の待ちは 400ms + 1200ms。最後の後にも待つと、さらに 3600ms かかる
    assert.ok(elapsed < 3000, `待ちすぎ：${elapsed}ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test('ストリームが途中で止まったら無応答の期限で打ち切り、超時と伝える', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"前半"}}]}\n\n'));
      // 本物の fetch では、中止すると本文のストリームも中止理由で失敗する
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
    },
  }));
  try {
    const deltas = [];
    const result = await chat({ baseUrl: 'http://localhost/v1', model: 'm', messages: [], onDelta: (x) => deltas.push(x), timeoutMs: 80 });
    assert.equal(result.ok, false);
    assert.match(result.error, /超时/);
    assert.deepEqual(deltas, ['前半']);
  } finally {
    globalThis.fetch = original;
  }
});

test('ASR の期限切れは「已取消」ではなく超時として返す', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = hangingFetch(calls);
  try {
    const result = await transcribe({
      endpoint: 'http://127.0.0.1:8081/v1/audio/transcriptions', model: 'small', audio: new Uint8Array([1, 2, 3]), timeoutMs: 50,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /超时/);
    assert.equal(calls[0].aborted, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('API key を平文 http で機械の外へは送らない（回環アドレスは可）', async () => {
  const { isLoopbackUrl, plaintextKeyProblem } = await import('../src/core/endpoint.js');
  assert.equal(isLoopbackUrl('http://127.0.0.1:8082/v1'), true);
  assert.equal(isLoopbackUrl('http://localhost:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://[::1]:8080/v1'), true);
  assert.equal(isLoopbackUrl('http://192.168.1.5:8080/v1'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.example.com/v1'), false);
  assert.equal(plaintextKeyProblem('http://192.168.1.5/v1', ''), '', 'key が無ければ http でも構わない');
  assert.equal(plaintextKeyProblem('https://api.example.com/v1', 'sk-x'), '');

  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return okReply(); };
  try {
    const remote = await chat({ baseUrl: 'http://api.example.com/v1', apiKey: 'sk-secret', model: 'm', messages: [] });
    assert.equal(remote.ok, false);
    assert.match(remote.error, /https/);
    const asr = await transcribe({ endpoint: 'http://10.0.0.2/v1/audio/transcriptions', apiKey: 'k', model: 's', audio: new Uint8Array([1]) });
    assert.equal(asr.ok, false);
    assert.equal(calls, 0, '要求そのものを出してはならない');
    const local = await chat({ baseUrl: 'http://127.0.0.1:8082/v1', apiKey: 'sk-local', model: 'm', messages: [] });
    assert.equal(local.ok, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
