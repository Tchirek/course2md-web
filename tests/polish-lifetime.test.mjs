import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
const { PolishCoordinator, EARLY_POLISH_MIN_EVENTS } = await import('../src/content/polish-coordinator.js');

const controller = (extra = {}) => ({
  abort: new AbortController(),
  built: { segments: [{ id: 0, text: 'hello' }] },
  settings: { polish: true, polishEngine: 'local', llm: {} },
  status: 'ready',
  panel: { setState() {} },
  panelState: () => ({}),
  broadcast() {},
  ...extra,
});

test('an old polish request cannot clear the new run progress', async () => {
  const c = controller();
  const polisher = new PolishCoordinator(c);
  let fail;
  polisher.localPolishSettings = () => new Promise((_resolve, reject) => { fail = reject; });
  const old = polisher.runPolish();
  // a new run starts: its own run and polish lifetimes
  c.abort.abort();
  polisher.begin();
  c.abort = new AbortController();
  polisher.progress = { running: true, hasResult: false, done: 0, total: 0 };
  fail(new Error('old request aborted'));
  await assert.rejects(old, /old request/);
  assert.equal(polisher.progress.running, true);
});

test('润色设置在收尾阶段变了：先排队，生成结束时按新设置重润；平时则立即重润', () => {
  const c = controller();
  const polisher = new PolishCoordinator(c);
  const calls = [];
  polisher.repolish = (options) => { calls.push(options ?? {}); };
  const off = { polish: false, polishEngine: 'local', llm: {} };

  polisher.prepareFinish();
  assert.equal(polisher.busy, true, '收尾阶段的导出要等');
  polisher.settingsChanged(off, c.settings);
  assert.deepEqual(calls, [], '收尾时不另起一轮');
  assert.equal(polisher.restartPending, true);
  polisher.afterRun();
  assert.equal(polisher.busy, false);
  assert.deepEqual(calls, [{}], '结束时补上');

  polisher.settingsChanged(off, c.settings);
  assert.deepEqual(calls, [{}, { reset: false }], '笔记已成、没在润色：立即重润');
  polisher.settingsChanged(c.settings, { ...c.settings, polishLevel: 'deep' });
  assert.deepEqual(calls.at(-1), { reset: true }, '换了润色档位：从头再润');
});

test('转录途中勾上润色，攒够的事件立即开始提前润色；取消勾选则停掉手头的润色', () => {
  const liveEvents = Array.from({ length: EARLY_POLISH_MIN_EVENTS }, (_, i) => ({ start: i, end: i + 1, text: 'x' }));
  const c = controller({ built: null, status: 'running', liveEvents });
  const polisher = new PolishCoordinator(c);
  const early = [];
  polisher.startEarlyPolish = (events) => { early.push(events.length); };
  polisher.settingsChanged({ polish: false, polishEngine: 'local', llm: {} }, c.settings);
  assert.deepEqual(early, [EARLY_POLISH_MIN_EVENTS]);

  polisher.abort = new AbortController();
  polisher.progress.running = true;
  polisher.settingsChanged(c.settings, { ...c.settings, polish: false });
  assert.equal(polisher.abort.signal.aborted, true);
});
