// 真实本机取帧实验：离线视频直接交给助手，播放器无需跳进度。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { visualSections } from '../src/content/visual.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dir, 'scene-density-test.mp4');
const port = 8767;
const made = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1:d=30',
  '-f', 'lavfi', '-i', 'color=c=white:s=160x90:r=1:d=20',
  '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=1:d=30',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'ultrafast', file,
], { encoding: 'utf8' });
if (made.status !== 0) throw new Error(made.stderr || '无法生成实验视频');
const helper = spawn(process.execPath, [path.join(dir, 'fast-asr-server.mjs')], {
  env: { ...process.env, C2MD_HELPER_PORT: String(port) }, stdio: 'ignore',
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
  const source = [{ t: 0, title: '实验', segments: Array.from({ length: 80 }, (_, start) => ({ start, end: start + 1, text: '讲述' })) }];
  const counts = {};
  const frames = {};
  for (const level of ['none', 'few', 'default', 'many']) {
    const times = visualSections(source, 80, level).map((section) => section.t);
    if (level === 'none') { counts[level] = 0; continue; }
    const response = await fetch(`http://127.0.0.1:${port}/frames`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceUrl: pathToFileURL(file).href, times }),
    });
    assert.equal(response.status, 200);
    const { id } = await response.json();
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 150));
      job = await (await fetch(`http://127.0.0.1:${port}/jobs/${id}`)).json();
    } while (job.state === 'running');
    assert.equal(job.state, 'done', job.error);
    assert(job.images.every((image) => image.data.startsWith('data:image/jpeg;base64,')));
    counts[level] = job.images.length;
    frames[level] = job.images;
  }
  assert.deepEqual(counts, { none: 0, few: 1, default: 2, many: 8 });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${webPort}/tools/selftest.html`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new' });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${webPort}/tools/selftest.html`);
  const kept = await page.evaluate(async (images) => {
    const { visualSections, captureSectionImages } = await import('/src/content/visual.js');
    const source = [{ t: 0, title: '实验', segments: Array.from({ length: 80 }, (_, start) => ({ start, end: start + 1, text: '讲述' })) }];
    const result = { none: 0 };
    for (const level of ['few', 'default', 'many']) {
      chrome.runtime.sendMessage = async (message) => message.type === 'frame.start'
        ? { ok: true, value: { id: level } }
        : { ok: true, value: { state: 'done', images: images[level].slice(message.payload.after) } };
      const sections = visualSections(source, 80, level);
      await captureSectionImages('file:///offline.mp4', sections);
      result[level] = sections.filter((section) => section.image).length;
    }
    return result;
  }, frames);
  assert.deepEqual(kept, { none: 0, few: 1, default: 2, many: 3 });
  process.stdout.write(`${JSON.stringify(kept)}\n`);
} finally {
  await browser?.close();
  helper.kill();
  web.kill();
  await unlink(file).catch(() => {});
}
