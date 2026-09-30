import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constraintsText, cudaWheels, expectedStamp } from '../tools/asr-runtime.mjs';
import { withLock } from '../tools/install-lock.mjs';

const PINS = JSON.parse(readFileSync(new URL('../tools/runtime-pins.json', import.meta.url), 'utf8'));

test('本机转录环境的每个包都固定到精确版本', () => {
  const lines = constraintsText().trim().split('\n');
  assert.equal(lines.length, Object.keys(PINS['asr-python'].packages).length);
  for (const line of lines) assert.match(line, /^[A-Za-z0-9_.-]+==[0-9][0-9A-Za-z.]*$/);
  assert.ok(lines.includes('ctranslate2==4.8.1'));
  assert.ok(lines.includes('faster-whisper==1.2.1'));
});

test('显卡加速库按版本和各平台文件的 SHA-256 固定', () => {
  for (const key of ['win32-x64', 'linux-x64']) {
    for (const wheel of cudaWheels(key)) {
      assert.match(wheel.sha256, /^[0-9a-f]{64}$/);
      assert.ok(wheel.file.includes(wheel.version));
      assert.ok(wheel.size > 100);
    }
  }
  // cuBLAS matches CTranslate2's build (CUDA 12.8); cuDNN matches the cudnn64_9.dll it bundles (9.10.2)
  const versions = Object.fromEntries(cudaWheels('win32-x64').map((wheel) => [wheel.package, wheel.version]));
  assert.match(versions['nvidia-cublas-cu12'], /^12\.8\./);
  assert.match(versions['nvidia-cudnn-cu12'], /^9\.10\.2\./);
});

test('只在有 NVIDIA 官方包的平台上安装显卡加速库', () => {
  assert.deepEqual(cudaWheels('win32-x64').map((wheel) => wheel.package), ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12']);
  for (const wheel of cudaWheels('win32-x64')) assert.match(wheel.file, /-win_amd64[.]whl$/);
  for (const wheel of cudaWheels('linux-x64')) assert.match(wheel.file, /-manylinux_2_27_x86_64[.]whl$/);
  assert.equal(cudaWheels('darwin-arm64').length, 0);
});

test('环境标记随固定版本和是否含显卡库而变', () => {
  assert.notEqual(expectedStamp(true), expectedStamp(false));
  assert.equal(expectedStamp(true), expectedStamp(true));
});

test('安装锁：同一目录的安装一个接一个进行', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'c2md-lock-')), '.install.lock');
  const order = [];
  const job = (name) => withLock(file, async () => {
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    order.push(`${name}:end`);
  });
  await Promise.all([job('a'), job('b')]);
  assert.deepEqual(order.slice(0, 2), [order[0], order[0].replace('start', 'end')]);
});

test('安装锁：持有者进程已不在时不会一直等下去', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'c2md-lock-')), '.install.lock');
  // a lock left by a process id that does not exist
  writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  const value = await withLock(file, async () => 'ran', { timeoutMs: 10_000 });
  assert.equal(value, 'ran');
});
