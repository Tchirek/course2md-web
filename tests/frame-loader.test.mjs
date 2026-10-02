import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameLoader } from '../src/content/frame-loader.js';

test('density switches reuse one CLI catalogue and keep paragraph objects', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => { globalThis.chrome = previous; });
  let started = 0;
  globalThis.chrome = { runtime: { sendMessage: async (message) => {
    if (message.type === 'frame.start') { started++; return { ok: true, value: { id: 'test' } }; }
    return { ok: true, value: { state: 'done', images: [{ time: 10, data: 'one' }, { time: 70, data: 'two' }] } };
  } } };
  const segments = [{ start: 0, end: 90, text: 'paragraph' }];
  const controller = { settings: { imageLevel: 'default' }, imageLevel: 'default', meta: { url: 'https://example.com/video' }, built: { sections: [{ t: 0, segments }] }, imageError: null, broadcast() {}, async saveCache() {} };
  const frames = new FrameLoader(controller);
  const pending = frames.refreshImages();
  controller.settings.imageLevel = 'few';
  frames.refreshImages();
  await pending;
  assert.equal(frames.complete, true);
  assert.equal(controller.previewSections[0].segments, segments);
  assert.deepEqual(controller.previewSections[0].frames.map((frame) => frame.t), [10]);
  controller.settings.imageLevel = 'many';
  await frames.refreshImages();
  assert.equal(started, 1);
  assert.deepEqual(controller.previewSections[0].frames.map((frame) => frame.t), [10, 70]);
});

test('navigation during signature computation cannot restore a stale frame', async (t) => {
  const previous = globalThis.createImageBitmap;
  t.after(() => { globalThis.createImageBitmap = previous; });
  let finish;
  globalThis.createImageBitmap = () => new Promise((_resolve, reject) => { finish = reject; });
  const frames = new FrameLoader({});
  const pending = frames.remember(1, 'data:image/jpeg;base64,AA==');
  frames.reset();
  finish(new Error('old image cancelled'));
  await pending;
  assert.equal(frames.cache.size, 0);
  assert.equal(frames.signatures.size, 0);
  globalThis.createImageBitmap = async () => { throw new Error('invalid image'); };
  await frames.remember(2, 'invalid image');
  assert.equal(frames.cache.get(2), 'invalid image', 'current images survive even if signature decoding fails');
});
