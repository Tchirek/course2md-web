//! 布局断言：用几何量而不是肉眼判断面板有没有坏掉。
//!
//! 这次的教训来自两个只有截图才能发现的 bug：
//!   1. 基础复位 `.c2md-scope button` 的权重压过了 `.c2md-button--primary`，
//!      主按钮的填充色静默消失；
//!   2. `grid-template-rows` 写了 6 行而子元素只有 5 个，正文拿到 auto、
//!      底部被挤出可视区。
//! 这两类问题跑单测看不出来，肉眼扫一遍截图也容易漏。所以量出来：
//! 底部必须在可视区内、正文必须能滚、不能有横向溢出、主按钮必须真的有色。

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8798);
const BASE = `http://127.0.0.1:${PORT}`;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));
if (!CHROME) {
  console.error('没找到 Chrome。');
  process.exit(1);
}

const results = [];
const fail = (name, detail) => results.push({ ok: false, name, detail });
const pass = (name) => results.push({ ok: true, name });

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await waitFor(`${BASE}/tools/selftest.html`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--no-default-browser-check'],
});

try {
  // ---- 面板 ----
  for (const state of ['ready', 'polished', 'error']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 760 });
    await page.goto(`${BASE}/tools/selftest-panel.html?state=${state}`, {
      waitUntil: 'networkidle2',
    });
    await page.waitForFunction('window.__selftestReady === true');
    await sleep(250);

    const m = await page.evaluate(() => {
      const root = document.getElementById('c2md-panel-host')?.shadowRoot;
      if (!root) return null;
      const rect = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
      };
      const scope = root.querySelector('.c2md-scope');
      const body = root.querySelector('.c2md-panel-body');
      const foot = root.querySelector('.c2md-panel-foot');
      const primary = root.querySelector('.c2md-button--primary');
      const scopeRect = rect(scope);
      return {
        viewport: { w: innerWidth, h: innerHeight },
        scope: scopeRect,
        body: rect(body),
        foot: rect(foot),
        rows: getComputedStyle(scope).gridTemplateRows,
        childCount: scope.children.length,
        // 栅格项数要排除 display:none 的元素——它们不参与栅格，
        // 但会让「行数 == 子元素数」这种断言误判通过
        gridItems: [...scope.children].filter(
          (c) => getComputedStyle(c).display !== 'none',
        ).length,
        hiddenChildren: [...scope.children]
          .filter((c) => getComputedStyle(c).display === 'none')
          .map((c) => String(c.className)),
        bodyScrolls: body.scrollHeight > body.clientHeight + 1,
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
        horizontalOverflow: scope.scrollWidth - scope.clientWidth,
        primaryBg: primary ? getComputedStyle(primary).backgroundColor : null,
        primaryText: primary ? primary.textContent : null,
      };
    });

    if (!m) {
      fail(`panel/${state}`, '面板没有渲染出来');
      await page.close();
      continue;
    }

    // 面板宽度：1280 的视口下必须是 384，不该铺满
    if (Math.abs(m.scope.w - 384) > 1) {
      fail(`panel/${state}`, `面板宽度是 ${m.scope.w}px，应为 384px`);
    } else pass(`panel/${state} 宽度 384px`);

    // 行数与**参与栅格的**子元素个数必须一致，否则伸缩行会错位
    const rowCount = m.rows.split(' ').length;
    if (rowCount !== m.gridItems) {
      fail(
        `panel/${state}`,
        `grid 有 ${rowCount} 行，但参与栅格的子元素有 ${m.gridItems} 个` +
          `（被 display:none 移出栅格的：${m.hiddenChildren.join(', ') || '无'}）`,
      );
    } else pass(`panel/${state} 行数与栅格项一致（${rowCount}）`);

    // 底部必须完整落在可视区内
    if (!m.foot || m.foot.bottom > m.viewport.h + 1 || m.foot.top < 0) {
      fail(
        `panel/${state}`,
        `底部动作条不在可视区内：top=${m.foot?.top} bottom=${m.foot?.bottom} 视口高=${m.viewport.h}`,
      );
    } else pass(`panel/${state} 底部动作条在可视区内`);

    // 正文必须能滚动，且不能横向溢出
    if (state === 'ready' && !m.bodyScrolls) {
      fail(`panel/${state}`, '正文内容超过一屏却没有滚动条');
    } else pass(`panel/${state} 正文滚动正常`);

    if (m.horizontalOverflow > 1) {
      fail(`panel/${state}`, `横向溢出 ${m.horizontalOverflow}px`);
    } else pass(`panel/${state} 无横向溢出`);

    // 主按钮必须真的是标记色的实心块——这正是被权重问题吃掉的那个属性
    if (m.primaryBg && m.primaryBg !== 'rgba(0, 0, 0, 0)') {
      const isMark = /rgb\(36, 106, 80\)/.test(m.primaryBg) || /^rgb\(\d+, \d+, \d+\)$/.test(m.primaryBg);
      if (isMark) pass(`panel/${state} 主按钮有实心底色 ${m.primaryBg}`);
      else fail(`panel/${state}`, `主按钮底色意外：${m.primaryBg}`);
    } else {
      fail(`panel/${state}`, `主按钮没有底色（权重被复位规则覆盖了）：${m.primaryBg}`);
    }

    await page.close();
  }

  // ---- 弹窗与设置页：不能横向溢出 ----
  // 两边各有一个分段选择：弹窗是「文字来源」，设置页是「主题」。
  // 没有第二个分段选择是刻意的——本地转录只有「本机服务」一条路，见 DESIGN.md。
  for (const [name, path, size, expectedSegments] of [
    ['popup', '/src/ui/popup.html', { width: 360, height: 620 }, 1],
    ['options', '/src/ui/options.html', { width: 860, height: 900 }, 1],
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ ...size });
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' });
    await sleep(300);
    const m = await page.evaluate(() => ({
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      primaryBg: (() => {
        const el = document.querySelector('.c2md-button--primary');
        return el ? getComputedStyle(el).backgroundColor : null;
      })(),
      checkboxCount: document.querySelectorAll('.c2md-check').length,
      segmentedSelected: document.querySelectorAll('.c2md-segmented button[aria-pressed="true"]').length,
    }));
    if (m.docOverflow > 1) fail(name, `横向溢出 ${m.docOverflow}px`);
    else pass(`${name} 无横向溢出`);
    if (m.checkboxCount !== 3) fail(name, `勾选行有 ${m.checkboxCount} 个，应为 3 个`);
    else pass(`${name} 三处勾选就位`);
    if (m.segmentedSelected !== expectedSegments) {
      fail(name, `分段选择有 ${m.segmentedSelected} 个选中项，应为 ${expectedSegments} 个`);
    } else pass(`${name} 分段选择选中项数正确（${expectedSegments}）`);
    if (name === 'popup' && (!m.primaryBg || m.primaryBg === 'rgba(0, 0, 0, 0)')) {
      fail(name, '主按钮没有底色');
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
if (bad.length) process.exitCode = 1;

async function waitFor(url, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
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
