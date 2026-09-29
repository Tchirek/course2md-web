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
  for (const state of ['ready', 'running', 'polished', 'error']) {
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

    // 默认是可调整的浮窗；只有拖到最右侧才展开成全高侧栏。
    if (m.scope.w < 320 || m.scope.w > 900 || m.scope.top <= 0 || m.scope.right >= m.viewport.w) {
      fail(`panel/${state}`, `默认浮窗位置或宽度错误：${JSON.stringify(m.scope)}`);
    } else pass(`panel/${state} 默认以浮窗显示`);

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

    if (state === 'running') {
      const stable = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const before = panel.scope.querySelector('.c2md-panel-toggles');
        panel.setState({ sections: [...panel.state.sections] });
        return before === panel.scope.querySelector('.c2md-panel-toggles');
      });
      stable ? pass('panel/running 正文更新不重建悬停中的选项') : fail('panel/running', '正文更新重建了选项');
      const count = await page.evaluate(() => document.getElementById('c2md-panel-host')?.shadowRoot.querySelectorAll('.c2md-para').length ?? 0);
      count > 0 ? pass('panel/running 已完成的文本可见') : fail('panel/running', '运行中仍隐藏已完成的文本');
      const plainGate = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const plain = () => [...panel.scope.querySelectorAll('.c2md-panel-foot button')]
          .find((button) => button.getAttribute('aria-label') === '复制纯文本');
        const sections = panel.state.sections;
        const withText = plain()?.disabled;
        panel.setState({ sections: [] });
        const withoutText = plain()?.disabled;
        panel.setState({ sections });
        return { withText, withoutText, restored: plain()?.disabled };
      });
      plainGate.withText === false && plainGate.withoutText === true && plainGate.restored === false
        ? pass('panel/running 转录中可复制已生成的纯文本')
        : fail('panel/running', `运行中复制纯文本按钮状态错误：${JSON.stringify(plainGate)}`);
      const anchorStable = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const sections = panel.state.sections;
        const body = panel.scope.querySelector('.c2md-panel-body');
        body.scrollTop = 300;
        const paras = body.querySelectorAll('.c2md-para');
        const target = paras[Math.min(3, paras.length - 1)];
        const before = target.getBoundingClientRect().top;
        // 第一节新增图片（模拟取帧到达）：正在阅读的段落视口位置应保持不变
        const withImage = sections.map((section, index) => index === 0
          ? { ...section, image: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' } : section);
        panel.setState({ sections: withImage });
        const withFigure = target.getBoundingClientRect().top;
        // 再取消图片（模拟取消点选）：同样不应移动正文
        panel.setState({ sections });
        const afterRemoval = target.getBoundingClientRect().top;
        // 滚到顶时不加补偿：新图片自然出现，绝不自己滚动
        body.scrollTop = 0;
        panel.setState({ sections: withImage });
        const atTop = panel.scope.querySelector('.c2md-panel-body').scrollTop;
        panel.setState({ sections });
        return {
          sameNode: panel.scope.querySelector('.c2md-panel-body') === body,
          driftAdd: Math.abs(withFigure - before),
          driftRemove: Math.abs(afterRemoval - before),
          atTop,
        };
      });
      anchorStable.sameNode && anchorStable.driftAdd <= 2 && anchorStable.driftRemove <= 2 && anchorStable.atTop === 0
        ? pass('panel/running 图片增删不移动正在阅读的正文，顶部不自动滚')
        : fail('panel/running', `图片增删扰动了阅读位置：${JSON.stringify(anchorStable)}`);
    }
    if (state === 'ready') {
      const images = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const sections = panel.state.sections.map((section, index) => ({ ...section, image: index === 0 ? 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' : '' }));
        panel.setState({ sections });
        const before = panel.scope.querySelectorAll('.c2md-frame').length;
        panel.setState({ settings: { ...panel.state.settings, imageLevel: 'none' } });
        const hidden = panel.scope.querySelectorAll('.c2md-frame').length;
        panel.setState({ settings: { ...panel.state.settings, imageLevel: 'few' } });
        const restored = panel.scope.querySelectorAll('.c2md-frame').length;
        return { before, hidden, restored };
      });
      images.before === 1 && images.hidden === 0 && images.restored === 1
        ? pass('panel/ready 图片密度切到无即隐藏、切回即显示')
        : fail('panel/ready', `图片密度切换未生效：${JSON.stringify(images)}`);
      const gate = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        panel.setState({ imagesPending: true });
        const foot = panel.scope.querySelector('.c2md-panel-foot');
        const buttons = [...foot.querySelectorAll('button')];
        const copy = buttons.find((button) => button.textContent === '复制 Markdown');
        const save = buttons.find((button) => button.textContent.includes('下载图文'));
        const plain = buttons.find((button) => button.getAttribute('aria-label') === '复制纯文本');
        const pending = [copy?.disabled, save?.disabled, plain?.disabled];
        panel.setState({ imagesPending: false });
        return { pending };
      });
      gate.pending[0] && gate.pending[1] && gate.pending[2] === false
        ? pass('panel/ready 取帧中仅允许复制纯文本')
        : fail('panel/ready', `取帧导出限制错误：${JSON.stringify(gate)}`);
      const corner = await page.evaluate(() => {
        const rect = document.getElementById('c2md-panel-host').getBoundingClientRect();
        return { x: rect.right - 4, y: rect.bottom - 4, width: rect.width, height: rect.height };
      });
      await page.mouse.move(corner.x, corner.y);
      await page.mouse.down();
      await page.mouse.move(corner.x - 70, corner.y - 70, { steps: 8 });
      await page.mouse.up();
      const resized = await page.evaluate(() => {
        const rect = document.getElementById('c2md-panel-host').getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      resized.width < corner.width - 20 && resized.height < corner.height - 20
        ? pass('panel/ready 可拖拽右下角调整宽高')
        : fail('panel/ready', `浮窗尺寸调整失败：${JSON.stringify({ corner, resized })}`);
      await page.mouse.move(940, 86);
      await page.mouse.down();
      await page.mouse.move(1120, 86, { steps: 8 });
      await page.mouse.up();
      const dock = await page.evaluate(() => {
        const host = document.getElementById('c2md-panel-host');
        const rect = host.getBoundingClientRect();
        return { docked: host.dataset.docked, top: rect.top, bottom: rect.bottom, right: rect.right };
      });
      dock.docked === 'true' && dock.top === 0 && dock.bottom === 760 && dock.right === 1280
        ? pass('panel/ready 拖到右侧后吸附并展开')
        : fail('panel/ready', `拖动吸附失败：${JSON.stringify(dock)}`);
    }
    if (state === 'running') {
      const ring = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const row = [...panel.scope.querySelectorAll('.c2md-check')].find((node) => node.textContent.includes('润色文本'));
        const indicator = row?.querySelector('.c2md-ring');
        const status = panel.scope.querySelector('.c2md-panel-status');
        panel.setState({ polish: { running: true, done: 4, total: 11 } });
        return { inRow: Boolean(indicator), title: indicator?.title, updated: indicator?.getAttribute('aria-valuenow'), statusRing: Boolean(status?.querySelector('.c2md-ring')) };
      });
      ring.inRow && ring.title === '润色 4/11' && ring.updated === '4' && !ring.statusRing
        ? pass('panel/running 真实进度位于润色选项右侧')
        : fail('panel/running', `进度环位置或数值错误：${JSON.stringify(ring)}`);
      const asrRing = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        panel.setState({ status: 'running', stageLabel: '正在转写', stageRatio: .25 });
        const indicator = panel.scope.querySelector('.c2md-source .c2md-ring');
        return { title: indicator?.title, value: indicator?.getAttribute('aria-valuenow') };
      });
      asrRing.title === '转写 25/100' && asrRing.value === '25'
        ? pass('panel/running 转写进度使用实际比例')
        : fail('panel/running', `转写进度错误：${JSON.stringify(asrRing)}`);
    }
    if (state === 'polished') {
      const counts = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const skipped = panel.scope.querySelector('.c2md-para[data-state="skipped"]');
        const before = skipped?.style.display;
        panel.setState({ settings: { ...panel.state.settings, polish: false } });
        return { before, after: skipped?.style.display, original: skipped?.querySelector('.c2md-say')?.textContent };
      });
      counts.before === 'none' && counts.after !== 'none' && counts.original
        ? pass('panel/polished 可切回完整原版转录')
        : fail('panel/polished', `原版切换失败：${JSON.stringify(counts)}`);
    }
    if (state === 'ready' || state === 'polished') {
      const extra = await page.evaluate(() => [...window.__selftestPanel.scope.querySelectorAll('.c2md-panel-foot button')]
        .some((button) => /开始润色|润色中/.test(button.textContent)));
      !extra ? pass(`panel/${state} 无多余润色按钮`) : fail(`panel/${state}`, '仍有开始润色按钮');
    }

    await page.close();
  }

  // ---- 弹窗与设置页：不能横向溢出 ----
  // 设置页另有本机／自定义润色模型选择。
  for (const [name, path, size, expectedSegments] of [
    ['popup', '/src/ui/popup.html', { width: 360, height: 620 }, 2],
    ['options', '/src/ui/options.html', { width: 860, height: 900 }, 4],
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
    if (m.checkboxCount !== 2) fail(name, `勾选行有 ${m.checkboxCount} 个，应为 2 个`);
    else pass(`${name} 两处勾选就位`);
    if (m.segmentedSelected !== expectedSegments) {
      fail(name, `分段选择有 ${m.segmentedSelected} 个选中项，应为 ${expectedSegments} 个`);
    } else pass(`${name} 分段选择选中项数正确（${expectedSegments}）`);
    if (name === 'popup') {
      // 勾选「润色文本」后，强度与方式两行直接出现
      const after = await page.evaluate(() => new Promise((resolve) => {
        const polish = [...document.querySelectorAll('.c2md-check')]
          .find((node) => node.textContent.includes('润色文本'));
        polish?.click();
        setTimeout(() => resolve({
          pressed: document.querySelectorAll('.c2md-segmented button[aria-pressed="true"]').length,
          stable: !document.querySelector('.c2md-row-enter'),
        }), 250);
      }));
      after.pressed === 4 && after.stable
        ? pass('popup 勾选润色后强度与方式行直接出现')
        : fail('popup', `润色行出现检查失败：${JSON.stringify(after)}`);
      const steady = await page.evaluate(() => {
        const state = { ...window.chrome.__mock.settingsStatus, status: 'ready', busy: true,
          polish: { running: true, done: 1, total: 3 } };
        window.chrome.__mock.emitState(state);
        return document.getElementById('run').textContent;
      });
      steady === '重新生成' ? pass('popup 润色进行时主按钮保持重新生成')
        : fail('popup', `润色状态误改主按钮：${steady}`);
    }
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
