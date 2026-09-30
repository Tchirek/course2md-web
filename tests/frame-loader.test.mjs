import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameLoader } from '../src/content/frame-loader.js';

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
