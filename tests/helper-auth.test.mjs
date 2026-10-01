import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHelperToken } from '../tools/helper-data.mjs';
import { buildDoc, upstreamSnapshot } from '../src/core/format.js';

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

test('本机助手除 /health 外，没有访问令牌一律拒绝', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'c2md-auth-'));
  const port = await freePort();
  const helper = spawn(process.execPath, ['tools/fast-asr-server.mjs'], {
    env: { ...process.env, C2MD_HELPER_PORT: String(port), C2MD_DATA_DIR: dir, C2MD_UPSTREAM_CONFIG: join(dir, 'upstream') },
    stdio: 'ignore',
  });
  t.after(async () => {
    helper.kill();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch { /* 等待启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const call = (route, { token, origin, method = 'GET', body } = {}) => fetch(`${base}${route}`, {
    method,
    body,
    headers: { ...(token ? { 'x-c2md-token': token } : {}), ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  }).then((response) => response.status);

  const token = readHelperToken(dir);
  assert.match(token, /^[0-9a-f]{64}$/, '启动时生成令牌');
  assert.equal(await call('/health'), 200);
  assert.equal(await call('/asr/status'), 401);
  assert.equal(await call('/asr/status', { token: 'f'.repeat(64) }), 401);
  // 其他扩展请求读取本机文件
  const localFile = JSON.stringify({ sourceUrl: 'file:///C:/Windows/win.ini', endpoint: 'http://127.0.0.1:8081/v1/audio/transcriptions' });
  assert.equal(await call('/transcribe', { method: 'POST', body: localFile, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), 401);
  assert.equal(await call('/frames', { method: 'POST', body: localFile }), 401);
  assert.equal(await call('/library/discover', { method: 'POST', body: '{}' }), 401);
  const fresh = await fetch(`${base}/library/discover`, { method: 'POST', headers: { 'x-c2md-token': token }, body: '{}' }).then((r) => r.json());
  assert.equal(fresh.libraries[0].root, join(dir, 'upstream', 'desktop-local-library'));
  assert.equal(fresh.defaultLibrary, fresh.libraries[0].id);
  assert.equal(await call('/library/connect', { method: 'POST', body: JSON.stringify({ root: dir }), token }), 200);
  assert.equal(await call('/library/discover', { method: 'POST', body: '{}', token }), 200);
  const libraryCall = async (action, input) => {
    const response = await fetch(`${base}/library/${action}`, { method: 'POST',
      headers: { 'x-c2md-token': token, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const value = await response.json();
    assert.equal(response.status, 200, value.error);
    return value;
  };
  const library = (await libraryCall('discover', {})).libraries[0].id;
  const sections = [{ t: 0, end: 20, segments: [{ start: 0, end: 20, text: '课程正文'.repeat(15_000), raw: '未经处理的原文' }],
    frames: [{ t: 0, image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOQAAAABJRU5ErkJggg==' }] }];
  const snapshot = upstreamSnapshot(buildDoc({ title: '测试课', duration: 20, url: 'https://www.youtube.com/watch?v=fixture' }, sections), sections);
  const saved = await libraryCall('publish', { ...snapshot, library, requestId: 'http-test', events: [{ start: 0, end: 1, text: '原始字幕' }] });
  const read = await libraryCall('read', { ...saved, library });
  assert.equal(read.document.sections[0].speech[0].text, sections[0].segments[0].text, '大于旧 128 KiB 限制的中文文档完整往返');
  assert.equal(read.manifest.source_id, 'online:youtube:7:fixture');
  assert.equal((await libraryCall('image', { ...saved, library, image: 'frames/slide_0001.png' })).data, sections[0].frames[0].image);
  assert.equal((await libraryCall('list', { library })).courses.length, 1);
  assert.equal(await call('/asr/status', { token }), 200);
  assert.equal(await call('/asr/status', { token, origin: 'https://evil.example' }), 403, '拒绝网页的 Origin');

  // 令牌换掉后旧令牌失效；被删除就重新生成
  const rotated = 'a'.repeat(64);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(dir, 'helper-token'), rotated);
  assert.equal(await call('/asr/status', { token }), 401);
  assert.equal(await call('/asr/status', { token: rotated }), 200);
  await unlink(join(dir, 'helper-token'));
  assert.equal(await call('/asr/status', { token: rotated }), 401);
  assert.equal(await call('/asr/status', { token: readHelperToken(dir) }), 200);
});
