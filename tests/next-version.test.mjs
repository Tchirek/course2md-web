import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from '../tools/next-version.mjs';

test('manifest 的版本还没发布过就发布它', () => {
  assert.equal(nextVersion('0.5.0', ['v0.4.0', 'v0.4.1']), '0.5.0');
});

test('已发布过就在同一个主.次版本里递增修订号', () => {
  assert.equal(nextVersion('0.4.0', ['v0.3.0', 'v0.4.0']), '0.4.1');
  assert.equal(nextVersion('0.4.0', ['v0.4.0', 'v0.4.1', 'v0.4.2', 'v0.3.9']), '0.4.3');
  // 文字列ではなく数として比べる：10 は 9 より大きい
  assert.equal(nextVersion('0.4.0', ['v0.4.0', 'v0.4.9', 'v0.4.10']), '0.4.11');
});

test('其他主.次版本的 tag 不影响', () => {
  assert.equal(nextVersion('0.4.0', ['v0.4.0', 'v1.4.7', 'v0.40.2']), '0.4.1');
});
