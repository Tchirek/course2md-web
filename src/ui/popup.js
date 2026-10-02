//! 弹窗：显示选项 + 文字来源 + 生成。
//!
//! 弹窗只做两件事——把设置写下去、把「开始」发出去。真正的进度与正文都在
//! 页面内面板里，所以关掉弹窗不会打断任何工作。

import { segmented, displayToggleRows, progress, note, applyTheme } from './controls.js';
import { icon } from './icons.js';
import { reloadIfCodeChanged } from '../core/build.js';
import { DEFAULT_SETTINGS, withDefaults } from '../core/settings.js';

/**
 * 取 popup.html 里固定存在的元素；缺了就是页面与脚本对不上，直接说清楚。
 * @param {string} id
 */
function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup.html 缺少 #${id}`);
  return node;
}

const runButton = byId('run');
if (!(runButton instanceof HTMLButtonElement)) throw new Error('popup.html 的 #run 应当是按钮');

const el = {
  title: byId('page-title'),
  pageMeta: byId('page-meta'),
  source: byId('source-control'),
  toggles: byId('toggles'),
  status: byId('status'),
  run: runButton,
  secondary: byId('secondary'),
  options: byId('open-options'),
};

// 读到存储里的设置之前先用默认值
/** @type {import('../core/settings.js').Settings} */
let settings = structuredClone(DEFAULT_SETTINGS);
/** @type {chrome.tabs.Tab|undefined} */
let tab;
/** 页面控制器广播的状态里，弹窗用得到的部分 */
/** @type {{status?: string, stageRatio?: number|null, error?: unknown}|null} */
let state = null;

// ---------- 启动 ----------

init();

async function init() {
  el.options.appendChild(icon('settings', { size: 16 }));
  el.options.addEventListener('click', () => chrome.runtime.openOptionsPage());

  const [reply, activeTabs] = await Promise.all([
    send({ type: 'settings.load' }).catch(() => null),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  settings = withDefaults(reply ?? {});
  applyTheme(settings);

  [tab] = activeTabs;
  // 解凍した拡張はファイルを更新しても後台が古いコードのまま動き、新しいMizoreLinkと噛み合わない
  // （401 など）。ポップアップは常にディスク上の新しいコードなので、ここで食い違いを見つけて
  // 拡張を読み込み直す。作業中のタブがあるときは中断しないよう見送る
  const busy = await ask({ type: 'c2md.ping' }).then((reply) => reply?.busy).catch(() => false);
  if (!busy && await reloadIfCodeChanged().catch(() => false)) return;
  renderPage();
  renderSource();
  renderToggles();

  el.run.addEventListener('click', () => start());
  el.secondary.addEventListener('click', () => showPanel());

  // 页面里的控制器会广播状态，弹窗跟着刷新
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'c2md.state') return;
    state = message.payload;
    renderStatus();
  });

  // 打开时先问一次现状
  const current = await ask({ type: 'c2md.status' }).catch(() => null);
  if (current) {
    state = current;
    renderStatus();
  }
}

// ---------- 渲染 ----------

function renderPage() {
  const url = tab?.url ?? '';
  const site = siteOf(url);
  el.title.textContent = tab?.title || '未命名标签页';
  el.pageMeta.textContent = site ? '' : '此页面需授权视频访问';
}

function renderSource() {
  el.source.replaceChildren(
    segmented({
      options: [
        { value: 'subtitle', label: '平台字幕', title: '直接取平台已有的字幕，最快' },
        { value: 'asr', label: '语音转录', title: '按 CLI 配置转录，或使用自定义本机接口' },
      ],
      value: settings.source,
      onChange: (value) => patch({ source: value }),
    }),
  );

}

function renderToggles() {
  el.toggles.replaceChildren(
    displayToggleRows({
      settings,
      showPolishLevel: true,
      showPolishEngine: true,
      polishLevelWhenChecked: true,
      onChange: (patchObject) => patch(patchObject),
      onSetup: () => chrome.runtime.openOptionsPage(),
    }),
  );
  // 分组标题补在勾选行上面，与「文字来源」的层级一致
  const heading = document.createElement('h2');
  heading.className = 'c2md-group-title';
  heading.textContent = '显示与处理';
  el.toggles.prepend(heading);
}

function renderStatus() {
  if (!state) return;
  const running = state.status === 'running';
  el.run.disabled = running;
  const label = running ? '生成中' : state.status === 'ready' ? '重新生成' : '生成笔记';
  if (el.run.textContent !== label) el.run.textContent = label;

  const hasContent = running || state.status === 'ready' || Boolean(state.error);
  el.secondary.hidden = !hasContent;
  if (el.secondary.textContent !== '在页面打开') el.secondary.textContent = '在页面打开';

  el.status.dataset.tone = 'default';
  if (running) el.status.replaceChildren(progress({ ratio: state.stageRatio ?? null }));
  else if (el.status.childNodes.length) el.status.replaceChildren();
}

// ---------- 行为 ----------

/**
 * 改设置：先落盘再重绘。storage.onChanged 也会推一次，两条路径都写同一份
 * 状态，所以不需要额外的同步逻辑。
 */
async function patch(/** @type {object} */ patchObject) {
  const reply = await send({ type: 'settings.save', payload: { patch: patchObject } }).catch(
    () => null,
  );
  if (reply?.settings) settings = reply.settings;
  else Object.assign(settings, patchObject);

  applyTheme(settings);
  renderSource();
  renderToggles();
  if (reply?.notes?.length) {
    el.status.dataset.tone = 'default';
    el.status.replaceChildren();
    for (const text of reply.notes) {
      const p = document.createElement('div');
      p.textContent = text;
      el.status.appendChild(p);
    }
  }
}

async function start() {
  el.run.disabled = true;
  el.status.dataset.tone = 'default';
  el.status.replaceChildren(progress({ ratio: null, label: '正在连接页面' }));

  try {
    const ready = await ensureController();
    if (!ready) return;
    const reply = await ask({ type: 'c2md.run' });
    if (reply?.status === 'running' || reply?.status === 'ready') {
      // 页面面板已经接管进度；弹窗立即让出画面。
      window.close();
    } else {
      state = reply ?? state;
      renderStatus();
    }
  } catch (error) {
    el.status.dataset.tone = 'error';
    el.status.replaceChildren();
    const p = document.createElement('div');
    p.textContent = String(/** @type {{message?: string}} */ (error)?.message ?? error);
    el.status.appendChild(p);
  } finally {
    el.run.disabled = false;
  }
}

async function showPanel() {
  if (!await ensureController()) return;
  try {
    await ask({ type: 'c2md.showPanel' });
    window.close();
  } catch (error) {
    showError('无法打开浮窗', String(/** @type {{message?: string}} */ (error)?.message ?? error));
  }
}

/**
 * 确认页面里有内容脚本。
 * 内置站点是声明式注入的，但如果页面在安装/更新扩展之前就已打开，脚本并不在。
 * 这时用 activeTab 权限主动注入一次。
 */
async function ensureController() {
  if (!tab?.id) return false;

  const ping = await ask({ type: 'c2md.ping' }, 1500).catch(() => null);
  if (ping?.ready) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/boot.js'],
    });
  } catch (error) {
    showError(
      '无法在这个页面运行',
      `${String(/** @type {{message?: string}} */ (error)?.message ?? error)}\n` +
        '内置站点不需要额外授权；其他页面请在扩展详情里允许「在此站点上」访问。',
    );
    return false;
  }

  // 等脚本把控制器接起来
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    const pong = await ask({ type: 'c2md.ping' }, 1200).catch(() => null);
    if (pong?.ready) return true;
  }
  showError('页面没有响应', '内容脚本没能启动。刷新页面后再试一次。');
  return false;
}

/**
 * @param {string} title
 * @param {string} body
 */
function showError(title, body) {
  el.status.dataset.tone = 'error';
  el.status.replaceChildren(note({ title, body, tone: 'error' }));
}

/** @param {string} url */
function siteOf(url) {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)youtube\.com$/.test(host)) return 'YouTube';
    if (/(^|\.)bilibili\.com$/.test(host)) return '哔哩哔哩';
    return '';
  } catch {
    return '';
  }
}

// ---------- 与页面控制器通信 ----------

/** @typedef {{type: string, payload?: object}} Message */

/**
 * 发给后台。
 * @param {Message} message
 * @returns {Promise<any>} 后台返回的值（类型随请求而不同）
 */
function send(message) {
  return chrome.runtime.sendMessage(message).then((reply) => {
    if (!reply) throw new Error('扩展后台没有响应');
    if (!reply.ok) throw new Error(reply.error ?? '未知错误');
    return reply.value;
  });
}

/**
 * 发给当前标签页里的控制器。
 * @param {Message} message
 * @param {number} [timeoutMs] 0 表示不限时
 * @returns {Promise<any>} 控制器返回的值；没有标签页时为 null
 */
async function ask(message, timeoutMs = 10_000) {
  if (!tab?.id) return null;
  const task = chrome.tabs.sendMessage(tab.id, message).then((reply) => {
    if (!reply) throw new Error('页面没有响应');
    if (!reply.ok) throw new Error(reply.error ?? '未知错误');
    return reply.value;
  });
  if (!timeoutMs) return task;
  return Promise.race([
    task,
    sleep(timeoutMs).then(() => {
      throw new Error('页面响应超时');
    }),
  ]);
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
