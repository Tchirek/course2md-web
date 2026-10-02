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
import { existsSync, mkdirSync } from 'node:fs';
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
  pipe: true,
  dumpio: Boolean(process.env.CI),
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
        primaryText: primary ? primary.dataset.label ?? primary.textContent : null,
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
      const anchorStable = await page.evaluate(async () => {
        const panel = window.__selftestPanel;
        const sections = panel.state.sections;
        const body = panel.scope.querySelector('.c2md-panel-body');
        body.scrollTop = 300;
        const paras = body.querySelectorAll('.c2md-para');
        const target = paras[Math.min(3, paras.length - 1)];
        const before = target.getBoundingClientRect().top;
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        // 第一节新增图片（模拟取帧到达）：正在阅读的段落视口位置应保持不变
        const withImage = sections.map((section, index) => index === 0
          ? { ...section, frames: [{ t: section.segments[0].start, image: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' }] } : section);
        panel.setState({ sections: withImage });
        await frame(); // 原生滚动锚定在渲染帧里补偿，量之前先等它落地
        const withFigure = target.getBoundingClientRect().top;
        // 再取消图片（模拟取消点选）：同样不应移动正文
        panel.setState({ sections });
        await frame();
        const afterRemoval = target.getBoundingClientRect().top;
        // 滚到顶时锚定不生效：新图片自然出现，绝不自己滚动
        body.scrollTop = 0;
        panel.setState({ sections: withImage });
        await frame();
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
      const images = await page.evaluate(async () => {
        const panel = window.__selftestPanel;
        const originalSections = panel.state.sections;
        const originalSettings = panel.state.settings;
        const sections = originalSections.map((section, index) => ({ ...section, frames: index === 0 ? [{ t: section.segments[0].start, image: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' }] : [] }));
        panel.setState({ sections });
        const withImage = panel.scope.querySelectorAll('.c2md-frame img').length;
        const boxes = panel.scope.querySelectorAll('.c2md-frame').length;
        // 档位切换时正在阅读的段落不应被图片框的增删顶动（原生滚动锚定补偿）。
        // 目标要滚到正文深处：贴近顶部时锚定需要的 scrollTop 会变负、被钳到 0，
        // 那是物理上保不住位置的情形，不算扰动。
        const body = panel.scope.querySelector('.c2md-panel-body');
        const paras = body.querySelectorAll('.c2md-para');
        const target = paras[paras.length - 2];
        target.scrollIntoView({ block: 'center' });
        const beforeTop = target.getBoundingClientRect().top;
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        panel.setState({ settings: { ...originalSettings, imageLevel: 'none' } });
        await frame();
        const boxesNone = panel.scope.querySelectorAll('.c2md-frame').length;
        const noneTop = target.getBoundingClientRect().top;
        panel.setState({ settings: { ...originalSettings, imageLevel: 'few' } });
        await frame();
        const boxesFew = panel.scope.querySelectorAll('.c2md-frame').length;
        const fewTop = target.getBoundingClientRect().top;
        panel.setState({ sections: originalSections, settings: originalSettings });
        return {
          withImage, boxes, boxesNone, boxesFew,
          driftNone: Math.abs(noneTop - beforeTop), driftFew: Math.abs(fewTop - beforeTop),
        };
      });
      images.withImage === 1 && images.boxes === 1 && images.boxesNone === 0 &&
      images.boxesFew === 1 && images.driftNone <= 2 && images.driftFew <= 2
        ? pass('panel/ready 图片有图才渲染且原生锚定兜住阅读位置')
        : fail('panel/ready', `图片档位切换扰动版面：${JSON.stringify(images)}`);
      const gate = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        panel.setState({ imagesPending: true });
        const foot = panel.scope.querySelector('.c2md-panel-foot');
        const buttons = [...foot.querySelectorAll('button')];
        const copy = buttons.find((button) => button.dataset.label === '复制 Markdown');
        const save = buttons.find((button) => button.dataset.label?.includes('下载图文'));
        const plain = buttons.find((button) => button.getAttribute('aria-label') === '复制纯文本');
        const pending = [copy?.disabled, save?.disabled, plain?.disabled];
        panel.setState({ imagesPending: false });
        return { pending };
      });
      gate.pending[0] && gate.pending[1] && gate.pending[2] === false
        ? pass('panel/ready 取帧中仅允许复制纯文本')
        : fail('panel/ready', `取帧导出限制错误：${JSON.stringify(gate)}`);
      // A run started from an idle, empty panel must replace "暂无笔记" with the loading state
      const emptyToLoading = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const saved = { status: panel.state.status, sections: panel.state.sections };
        const body = () => panel.scope.querySelector('.c2md-panel-body')?.textContent.trim() ?? '';
        panel.setState({ status: 'idle', sections: [] });
        const idle = body();
        panel.setState({ status: 'running' });
        const running = body();
        panel.setState(saved);
        return { idle, running };
      });
      emptyToLoading.idle === '暂无笔记' && emptyToLoading.running.includes('正在取文字')
        ? pass('panel/ready 从空面板开始生成时显示加载中')
        : fail('panel/ready', `空面板开始生成时状态不对：${JSON.stringify(emptyToLoading)}`);
      // 生成中提前按下复制/下载：按钮文字在「平常／完成后…／已…」间切换，尺寸与位置都不能变
      const armedSize = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const measure = () => [...panel.scope.querySelectorAll('.c2md-panel-foot .c2md-button')].slice(0, 2)
          .map((button) => {
            const r = button.getBoundingClientRect();
            return `${button.dataset.label}@${r.x.toFixed(2)},${r.y.toFixed(2)} ${r.width.toFixed(2)}x${r.height.toFixed(2)}`;
          });
        const none = { copy: false, download: false };
        const both = { copy: true, download: true };
        panel.setState({ exportReady: false, exportBusy: true, pendingExport: none, exportFlash: none });
        const idle = measure();
        panel.setState({ pendingExport: both });
        const armed = measure();
        panel.setState({ exportReady: true, exportBusy: false, pendingExport: none, exportFlash: both });
        const done = measure();
        panel.setState({ exportReady: undefined, exportBusy: undefined, pendingExport: undefined, exportFlash: undefined });
        return { idle, armed, done };
      });
      const geometry = (list) => list.map((item) => item.split('@')[1]).join(' | ');
      const labelsChanged = armedSize.armed[0].startsWith('完成后复制') && armedSize.done[1].startsWith('已保存');
      labelsChanged && geometry(armedSize.idle) === geometry(armedSize.armed) && geometry(armedSize.idle) === geometry(armedSize.done)
        ? pass('panel/ready 提前按下复制/下载时按钮尺寸不变')
        : fail('panel/ready', `提前导出时按钮尺寸变化：${JSON.stringify(armedSize)}`);
      const warning = await page.evaluate(() => {
        const panel = window.__selftestPanel;
        const count = () => [...panel.scope.querySelectorAll('.c2md-panel-status .c2md-meta')]
          .filter((node) => node.textContent === '测试提醒').length;
        panel.setState({ warnings: ['测试提醒', '测试提醒'] });
        const first = count();
        panel.setState({ imagesPending: false }); // 提醒と無関係な再描画
        const second = count();
        panel.setState({ warnings: [] });
        return { first, second };
      });
      warning.first === 1 && warning.second === 1
        ? pass('panel/ready 提醒は重複せず、再描画をまたいで表示され続ける')
        : fail('panel/ready', `提醒の表示が不正：${JSON.stringify(warning)}`);
      // 密度切り替えで読んでいる行が 1px も動かないこと。スクロールアンカーはホイール操作で
      // 選ばれるので scrollTop の代入ではなく実際にホイールで読み進め、図は一枚ずつ届かせる。
      // 見るのは視口上端の段落（アンカーになる段落）で、許容は丸め誤差のみ。
      await page.evaluate(async () => {
        const { attachFrames } = await import('/src/content/visual.js');
        const panel = window.__selftestPanel;
        const text = '我们今天来聊一聊这个问题其实非常有意思因为大家平时可能没有注意到这里面的细节所以我想展开讲一下'.repeat(3);
        let id = 0;
        const sections = Array.from({ length: 8 }, (_, s) => ({
          t: s * 280,
          title: `第 ${s + 1} 节`,
          segments: Array.from({ length: 14 }, (_, k) => {
            const start = s * 280 + k * 20;
            const say = `${text.slice(0, 18 + ((s * 14 + k) * 37) % 90)}。`;
            return { id: id++, start, end: start + 19, text: say, raw: say, state: 'kept' };
          }),
        }));
        const canvas = Object.assign(document.createElement('canvas'), { width: 480, height: 270 });
        const images = new Map();
        for (const segment of sections.flatMap((section) => section.segments)) {
          const context = canvas.getContext('2d');
          context.fillStyle = `hsl(${segment.start % 360} 50% 50%)`;
          context.fillRect(0, 0, 480, 270);
          images.set(segment.start, canvas.toDataURL('image/jpeg', 0.5));
        }
        window.__density = { attachFrames, sections, images, original: { sections: panel.state.sections, settings: panel.state.settings } };
        panel.setState({ settings: { ...panel.state.settings, imageLevel: 'none' }, sections: attachFrames(sections, 'none') });
      });
      const bodyBox = await page.evaluate(() => {
        const rect = window.__selftestPanel.scope.querySelector('.c2md-panel-body').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await page.mouse.move(bodyBox.x, bodyBox.y);
      for (let i = 0; i < 16; i++) {
        await page.mouse.wheel({ deltaY: 173 });
        await sleep(40);
      }
      await sleep(400);
      const density = await page.evaluate(async () => {
        const { attachFrames, sections, images, original } = window.__density;
        const panel = window.__selftestPanel;
        const body = panel.scope.querySelector('.c2md-panel-body');
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        let movedParas = 0;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.removedNodes) if (node.classList?.contains('c2md-para') && node.isConnected) movedParas++;
          }
        });
        observer.observe(body, { childList: true, subtree: true });
        const top = body.getBoundingClientRect().top;
        const target = [...body.querySelectorAll('.c2md-para')].find((para) => para.getBoundingClientRect().bottom > top + 1);
        const origin = target.getBoundingClientRect().top;
        let worst = { drift: 0, at: '' };
        const check = (at) => {
          const drift = target.getBoundingClientRect().top - origin;
          if (Math.abs(drift) > Math.abs(worst.drift)) worst = { drift: Number(drift.toFixed(3)), at };
        };
        for (const level of ['few', 'default', 'many', 'none', 'default']) {
          panel.setState({ settings: { ...panel.state.settings, imageLevel: level } });
          await frame();
          check(`${level}/設定`);
          const next = attachFrames(sections, level);
          panel.setState({ sections: next });
          await frame();
          check(`${level}/節`);
          for (const item of next.flatMap((section) => section.frames)) {
            item.image = images.get(item.t);
            panel.setState({ sections: next.map((section) => ({ ...section })) });
            await frame();
            check(`${level}/図 ${item.t}`);
          }
        }
        observer.disconnect();
        const scrolled = body.scrollTop;
        panel.setState(original);
        return { scrolled, movedParas, worst };
      });
      density.scrolled > 0 && density.movedParas === 0 && Math.abs(density.worst.drift) < 0.01
        ? pass('panel/ready 画像の密度切替でも画像が一枚ずつ届いても、読んでいる行は動かない')
        : fail('panel/ready', `画像の密度切替で読んでいる行が動いた：${JSON.stringify(density)}`);
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
        ? pass('panel/polished 可切回完整原始转录')
        : fail('panel/polished', `原文切换失败：${JSON.stringify(counts)}`);
    }
    if (state === 'ready' || state === 'polished') {
      const extra = await page.evaluate(() => [...window.__selftestPanel.scope.querySelectorAll('.c2md-panel-foot button')]
        .some((button) => /开始润色|润色中/.test(button.textContent)));
      !extra ? pass(`panel/${state} 无多余润色按钮`) : fail(`panel/${state}`, '仍有开始润色按钮');
    }

    await page.close();
  }

  // Desktop integration is opt-in; the narrow toolbar keeps just one accessible action.
  for (const desktop of ['off', 'on']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 360, height: 760 });
    await page.goto(`${BASE}/tools/selftest-panel.html?state=ready&theme=dark&desktop=${desktop}`, { waitUntil: 'networkidle2' });
    await page.waitForFunction('window.__selftestReady === true');
    const m = await page.evaluate(() => {
      const panel = window.__selftestPanel;
      panel.setState({ exportReady: true, exportBusy: false });
      panel.host.style.width = '340px';
      const foot = panel.scope.querySelector('.c2md-panel-foot');
      const button = foot.querySelector('button[aria-label="同步到 course2md"]');
      return { count: Number(Boolean(button)), disabled: button?.disabled,
        overflow: foot.scrollWidth - foot.clientWidth };
    });
    m.count === (desktop === 'on' ? 1 : 0) && (desktop !== 'on' || !m.disabled) && m.overflow <= 1
      ? pass(`panel desktop=${desktop} 窄屏同步入口符合设置`)
      : fail(`panel desktop=${desktop}`, JSON.stringify(m));
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
      mkdirSync(join(ROOT, 'tools', 'shots'), { recursive: true });
      await page.screenshot({ path: join(ROOT, 'tools', 'shots', 'popup-ready.png') });
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
    if (name === 'options') {
      const disabled = await page.evaluate(() => document.getElementById('desktop-sync')?.checked === false);
      disabled ? pass('options 同步默认关闭') : fail('options', '同步默认开启');

      await page.waitForFunction(() => document.getElementById('helper-install').textContent === '更新助手');
      pass('options 已安装时自动连接并收起安装提示');
      await page.click('#helper-check');
      await page.waitForFunction(() => document.getElementById('helper-result').textContent.includes('已连接'));
      pass('options 可以检查助手连接');
    }
    await page.close();
  }
  for (const [os, suffix] of [['win', 'windows.exe'], ['mac', 'macos.pkg'], ['linux', 'linux.run']]) {
    const page = await browser.newPage();
    await page.goto(`${BASE}/src/ui/options.html?helper=missing&os=${os}`, { waitUntil: 'networkidle0' });
    const tabs = (await browser.pages()).length;
    await page.click('#helper-install');
    await page.waitForFunction(() => document.getElementById('helper-result').textContent.includes('50%'));
    const started = await page.evaluate(() => ({ options: chrome.__mock.downloadOptions[0], disabled: document.getElementById('helper-install').disabled, opened: chrome.__mock.openedDownloads.length }));
    started.options.url.endsWith(`/v0.7.1/course2md-helper-0.7.1-${suffix}`) && started.options.saveAs === false && started.disabled && !started.opened && (await browser.pages()).length === tabs
      ? pass(`options/${os} 在设置页下载对应安装器、显示进度且不自动执行`) : fail(`options/${os}`, JSON.stringify(started));
    if (os === 'win') {
      await page.evaluate(() => { chrome.__mock.downloadItems[0].paused = true; });
      await page.waitForFunction(() => document.getElementById('helper-install').textContent === '继续下载');
      await page.click('#helper-install');
      await page.waitForFunction(() => !chrome.__mock.downloadItems[0].paused);
      await page.evaluate(() => Object.assign(chrome.__mock.downloadItems[0], { state: 'interrupted', exists: false, error: 'NETWORK_FAILED' }));
      await page.waitForFunction(() => document.getElementById('helper-result').textContent.includes('点击可重试'));
      await page.click('#helper-install');
      await page.waitForFunction(() => chrome.__mock.downloadItems.length === 2);
      pass('options 下载暂停可继续，断网后可直接重试');
      await page.evaluate(() => Object.assign(chrome.__mock.downloadItems.at(-1), { danger: 'uncommon', bytesReceived: 100 }));
      await page.waitForFunction(() => document.getElementById('helper-install').textContent === '确认下载');
      await page.click('#helper-install');
      await page.waitForFunction(() => chrome.__mock.downloadItems.at(-1).danger === 'accepted');
      pass('options 下载警告由用户明确确认');
    } else {
      await page.evaluate(() => { chrome.__mock.downloadItems[0].state = 'complete'; });
    }
    await page.waitForFunction((label) => document.getElementById('helper-install').textContent === label, {}, os === 'linux' ? '安装器已下载' : '打开安装器');
    if (os === 'win') {
      await page.setViewport({ width: 390, height: 650 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      overflow <= 1 ? pass('options 窄屏安装提示无横向溢出') : fail('options/setup-layout', String(overflow));
      mkdirSync(join(ROOT, 'tools', 'shots'), { recursive: true });
      await page.screenshot({ path: join(ROOT, 'tools', 'shots', 'helper-setup.png') });
    }
    if (os !== 'linux') {
      await page.click('#helper-install');
      const opened = await page.evaluate(() => ({ files: chrome.__mock.openedDownloads, permission: chrome.__mock.permissionRequests.at(-1) }));
      opened.files.length === 1 && opened.permission.permissions[0] === 'downloads.open'
        ? pass(`options/${os} 用户再次点击才打开系统安装器`) : fail(`options/${os}`, JSON.stringify(opened));
      await page.evaluate(() => chrome.__mock.connectHelper());
      await page.waitForFunction(() => document.getElementById('helper-result').textContent.includes('已连接'));
      pass(`options/${os} 安装后自动连接，无需检查按钮`);
    } else {
      const linux = await page.evaluate(() => ({ disabled: document.getElementById('helper-install').disabled, opens: chrome.__mock.openedDownloads.length, text: document.getElementById('helper-result').textContent }));
      linux.disabled && !linux.opens && linux.text.includes('仍需运行此文件')
        ? pass('options/Linux 明确首次安装边界，不把打开脚本当成安装') : fail('options/linux', JSON.stringify(linux));
    }
    await page.close();
  }
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/src/ui/options.html?helper=missing&permission=denied`, { waitUntil: 'networkidle0' });
    await page.click('#helper-install');
    await page.evaluate(() => {
      const item = chrome.__mock.downloadItems[0];
      item.state = 'complete';
      sessionStorage.setItem('c2md-mock-downloads', JSON.stringify([item, { ...item, id: 2, byExtensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }]));
    });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('helper-install').textContent === '打开安装器');
    await page.click('#helper-install');
    await page.waitForFunction(() => document.getElementById('helper-result').textContent.includes('未允许'));
    const denied = await page.evaluate(() => ({ opens: chrome.__mock.openedDownloads.length, downloads: chrome.__mock.downloadOptions.length }));
    !denied.opens && !denied.downloads ? pass('options 刷新恢复本扩展的下载，拒绝打开权限不会执行或重下') : fail('options/permission', JSON.stringify(denied));
    await page.goto(`${BASE}/src/ui/options.html?helper=missing`, { waitUntil: 'networkidle0' });
    await page.click('#helper-install');
    await page.waitForFunction(() => chrome.__mock.openedDownloads.length === 1);
    const id = await page.evaluate(() => chrome.__mock.openedDownloads[0]);
    id === 1 ? pass('options 仅复用本扩展发起的安装器下载') : fail('options/download-owner', String(id));
    await page.evaluate(() => { chrome.__mock.downloadItems[0].exists = false; });
    await page.click('#helper-install');
    await page.waitForFunction(() => document.getElementById('helper-install').textContent === '安装本机助手');
    pass('options 安装器被删除后可重新下载');
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
