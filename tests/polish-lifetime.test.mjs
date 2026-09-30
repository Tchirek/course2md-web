import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
const { PolishCoordinator } = await import('../src/content/polish-coordinator.js');

test('an old polish request cannot clear the new run progress', async () => {
  const c = {
    abort: new AbortController(), polishAbort: new AbortController(),
    polishState: { running: false, hasResult: false },
    built: { segments: [{ id: 0, text: 'hello' }] },
    settings: { polishEngine: 'local', llm: {} },
    panel: { setState() {} },
  };
  const polisher = new PolishCoordinator(c);
  let fail;
  polisher.localPolishSettings = () => new Promise((_resolve, reject) => { fail = reject; });
  const old = polisher.runPolish();
  c.abort.abort();
  c.polishAbort.abort();
  c.abort = new AbortController();
  c.polishAbort = new AbortController();
  c.polishState = { running: true, hasResult: false };
  fail(new Error('old request aborted'));
  await assert.rejects(old, /old request/);
  assert.equal(c.polishState.running, true);
});
