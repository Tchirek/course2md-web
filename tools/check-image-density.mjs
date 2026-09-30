// 真实本机取帧实验：离线视频直接交给助手，播放器无需跳进度。
// 实验视频有三幕（黑 30 秒、白 20 秒、红 30 秒）：各档先按间距取候选帧，
// 再在真浏览器里算签名、去掉与上一张相似的，每一幕应只留一张。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { attachFrames } from '../src/content/visual.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));
if (!CHROME) throw new Error('没找到 Chrome / Edge');

const work = mkdtempSync(path.join(os.tmpdir(), 'c2md-density-'));
const file = path.join(work, 'scene-density-test.mp4');
const made = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1:d=30',
  '-f', 'lavfi', '-i', 'color=c=white:s=160x90:r=1:d=20',
  '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=1:d=30',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'ultrafast', file,
], { encoding: 'utf8' });
if (made.status !== 0) throw new Error(made.stderr || '无法生成实验视频');
const port = 8767;
// 独立的数据目录：令牌在这里生成，不碰真实安装的宿主注册
const helper = spawn(process.execPath, [path.join(dir, 'fast-asr-server.mjs')], {
  env: { ...process.env, C2MD_HELPER_PORT: String(port), C2MD_DATA_DIR: path.join(work, 'data') }, stdio: 'ignore',
});
const webPort = 8799;
const web = spawn(process.execPath, [path.join(dir, 'serve.mjs')], {
  env: { ...process.env, PORT: String(webPort) }, stdio: 'ignore',
});
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const token = readFileSync(path.join(work, 'data', 'helper-token'), 'utf8').trim();
  const call = async (url, body) => (await fetch(`http://127.0.0.1:${port}${url}`, {
    method: body ? 'POST' : 'GET', headers: { 'x-c2md-token': token }, body: body && JSON.stringify(body),
  })).json();
  const source = [{ t: 0, title: '实验', segments: Array.from({ length: 80 }, (_, start) => ({ start, end: start + 1, text: '讲述' })) }];
  const candidates = {};
  const frames = {};
  for (const level of ['few', 'default', 'many']) {
    const times = attachFrames(source, level).flatMap((section) => section.frames).map((frame) => frame.t);
    const { id, error } = await call('/frames', { sourceUrl: pathToFileURL(file).href, times });
    assert.ok(id, error);
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 150));
      job = await call(`/jobs/${id}`);
    } while (job.state === 'running');
    assert.equal(job.state, 'done', job.error);
    assert(job.images.every((image) => image.data.startsWith('data:image/jpeg;base64,')));
    candidates[level] = job.images.length;
    frames[level] = job.images;
  }
  assert.deepEqual(candidates, { few: 1, default: 2, many: 8 }, '候选帧按间距取');
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${webPort}/tools/selftest.html`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${webPort}/tools/selftest.html`);
  const kept = await page.evaluate(async (images) => {
    const { attachFrames } = await import('/src/content/visual.js');
    const { signatureOf } = await import('/src/content/frame-signature.js');
    const { keepChanged } = await import('/src/core/similarity.js');
    const source = [{ t: 0, title: '实验', segments: Array.from({ length: 80 }, (_, start) => ({ start, end: start + 1, text: '讲述' })) }];
    const result = {};
    for (const level of ['few', 'default', 'many']) {
      const cache = new Map(images[level].map((image) => [image.time, image.data]));
      const signatures = new Map();
      for (const [t, data] of cache) signatures.set(t, await signatureOf(data));
      result[level] = keepChanged(attachFrames(source, level, cache), signatures)
        .flatMap((section) => section.frames).map((frame) => frame.t);
    }
    return result;
  }, frames);
  // 多档：0 秒的黑、换幕后的第一张白（30 或 40 秒，视取帧落点）、50 秒的红
  assert.equal(kept.few.length, 1);
  assert.deepEqual(kept.default, [0, 60]);
  assert.equal(kept.many.length, 3, `多档每一幕只留一张：${kept.many}`);
  assert.deepEqual([kept.many[0], kept.many[2]], [0, 50]);
  process.stdout.write(`${JSON.stringify({ candidates, kept })}\n`);
} finally {
  await browser?.close();
  helper.kill();
  web.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(work, { recursive: true, force: true });
}
