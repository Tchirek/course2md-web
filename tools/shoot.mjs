//! 截图驱动：起本地服务器，用无头 Chrome 把每种界面状态截下来。
//!
//! Chrome 137 起 `--load-extension` 已不可用，所以这里不去装扩展，而是让
//! tools/serve.mjs 注入 chrome.* 替身，把同一批**真实的**界面文件渲染出来。
//! 产品代码不为截图做任何让步。

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'shots');
const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('没找到 Chrome/Edge 可执行文件。');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

// ---------- 起服务器 ----------

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));

await waitForServer(`${BASE}/tools/selftest.html`);
console.log(`服务器就绪： ${BASE}`);

// ---------- 起浏览器 ----------

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=2',
    '--hide-scrollbars',
  ],
});

const shots = [];

/**
 * @param {string} name 文件名
 * @param {string} path 相对路径（可带查询串）
 * @param {{width:number,height:number,wait?:string,full?:boolean,suffix?:string}} opts
 */
async function shoot(name, path, opts) {
  const page = await browser.newPage();
  await page.setViewport({
    width: opts.width,
    height: opts.height,
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 把资源 URL 带上，否则「有个 404」这种信息没法定位
    const where = m.location?.()?.url;
    errors.push(`console: ${m.text()}${where ? ` @ ${where}` : ''}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`);
  });

  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 30_000 });
  if (opts.wait) await page.waitForFunction(opts.wait, { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await sleep(350);

  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: Boolean(opts.full) });
  shots.push({ name, file, errors: [...new Set(errors)].filter((e) => !/favicon/i.test(e)) });
  console.log(`  ✓ ${name}${errors.length ? `  (${errors.length} 条页面错误)` : ''}`);
  await page.close();
}

console.log('截图中…');

// 弹窗：正常态 / 生成中 / 未接入 LLM
await shoot('popup-ready', '/src/ui/popup.html', { width: 360, height: 620 });
await shoot('popup-running', '/src/ui/popup.html?status=running', { width: 360, height: 620 });
await shoot('popup-no-llm', '/src/ui/popup.html?nollm=on', { width: 360, height: 620 });
await shoot('popup-no-asr', '/src/ui/popup.html?noasr=on', { width: 360, height: 620 });
await shoot('popup-dark', '/src/ui/popup.html?theme=dark', { width: 360, height: 620 });

// 设置页
await shoot('options', '/src/ui/options.html', {
  width: 860,
  height: 1100,
  full: true,
});
await shoot('options-dark', '/src/ui/options.html?theme=dark', {
  width: 860,
  height: 1100,
  full: true,
});

// 面板：各状态 × 深浅色 × 时刻开关
const panelStates = ['ready', 'polished', 'running', 'error', 'empty'];
for (const state of panelStates) {
  await shoot(`panel-${state}`, `/tools/selftest-panel.html?state=${state}`, {
    width: 1280,
    height: 760,
    wait: 'window.__selftestReady === true',
  });
}
await shoot('panel-dark', '/tools/selftest-panel.html?state=ready&theme=dark', {
  width: 1280,
  height: 760,
  wait: 'window.__selftestReady === true',
});
await shoot('panel-no-timestamps', '/tools/selftest-panel.html?state=ready&ts=off', {
  width: 1280,
  height: 760,
  wait: 'window.__selftestReady === true',
});
await shoot('panel-no-click', '/tools/selftest-panel.html?state=ready&seek=off', {
  width: 1280,
  height: 760,
  wait: 'window.__selftestReady === true',
});
await shoot('panel-polished-dark', '/tools/selftest-panel.html?state=polished&theme=dark', {
  width: 1280,
  height: 760,
  wait: 'window.__selftestReady === true',
});

// 自测台总览
await shoot('selftest-index', '/tools/selftest.html?state=ready', {
  width: 1280,
  height: 1100,
});

await browser.close();
server.kill();

const withErrors = shots.filter((s) => s.errors.length);
console.log(`\n共 ${shots.length} 张，目录：${OUT}`);
if (withErrors.length) {
  console.log('\n有页面错误的视图：');
  for (const s of withErrors) {
    for (const e of s.errors.slice(0, 4)) console.log(`  ${s.name}: ${e}`);
  }
  process.exitCode = 1;
}

async function waitForServer(url, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error(`服务器没起来：${url}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
