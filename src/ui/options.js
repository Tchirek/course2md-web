//! 设置页。
//!
//! 两个关键动作：
//!  - 「授权访问此地址」：把具体来源加进扩展权限。OpenAI 兼容的端点基本都不发
//!    CORS 头，没有这一步，请求会被浏览器拦掉。
//!  - 「测试连接」：真的发一次请求，把服务端的原话带回来，而不是只说「失败」。

import { segmented, displayToggleRows, polishEngineRow, applyTheme } from './controls.js';
import { withDefaults } from '../core/settings.js';
import { reloadIfCodeChanged } from '../core/build.js';

/** 字段表：DOM id -> 设置路径。声明式绑定，省掉一堆重复的 addEventListener。 */
/** @type {[id: string, path: string, kind: 'text'|'bool'|'number'][]} */
const FIELDS = [
  ['sub-lang', 'subtitle.preferLang', 'text'],
  ['sub-auto', 'subtitle.allowAuto', 'bool'],
  ['asr-endpoint', 'asr.endpoint', 'text'],
  ['asr-key', 'asr.apiKey', 'text'],
  ['asr-model', 'asr.model', 'text'],
  ['asr-language', 'asr.language', 'text'],
  ['asr-chunk', 'asr.chunkSeconds', 'number'],
  ['asr-rate', 'asr.playbackRate', 'number'],
  ['llm-url', 'llm.baseUrl', 'text'],
  ['llm-key', 'llm.apiKey', 'text'],
  ['llm-model', 'llm.model', 'text'],
  ['llm-concurrency', 'llm.concurrency', 'number'],
  ['llm-glossary', 'llm.glossary', 'text'],
  ['llm-instruction', 'llm.instruction', 'text'],
];

// init() 读到存储里的设置之前先用默认值
let settings = withDefaults({});
/** @type {ReturnType<typeof setInterval>|undefined} */
let asrPoll;
/** @type {ReturnType<typeof setInterval>|undefined} */
let polishPoll;
const LOCAL_ASR_ENDPOINT = 'http://127.0.0.1:8081/v1/audio/transcriptions';

init();

/**
 * 表单字段：单行输入框或多行文本框；找不到（或不是这两种）时为 null。
 * @param {string} id
 */
function field(id) {
  const node = document.getElementById(id);
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node : null;
}

/**
 * 页面里固定存在的元素；缺了就是页面与脚本对不上，直接说清楚。
 * @param {string} id
 */
function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`options.html 缺少 #${id}`);
  return node;
}

/** @param {string} id */
function buttonById(id) {
  const node = byId(id);
  if (!(node instanceof HTMLButtonElement)) throw new Error(`options.html 的 #${id} 应当是按钮`);
  return node;
}

/**
 * 本机服务（转录、润色）的状态，由后台转述本机助手的回答。
 * @typedef {{state: string, message?: string, model?: string}} LocalServiceStatus
 */

async function init() {
  // ポップアップと同じく、後台だけ古いコードのままなら拡張を読み込み直す
  if (await reloadIfCodeChanged().catch(() => false)) return;
  settings = withDefaults(await load());
  applyTheme(settings);
  fillFields();
  renderDisplay();
  renderPolishEngine();
  renderTheme();
  bindActions();
  send({ type: 'asr.local.status' }).then(showLocalAsrStatus).catch(() => {});
  send({ type: 'polish.local.status' }).then(showLocalPolishStatus).catch(() => {});

  // 用户在弹窗里改了勾选，设置页开着的话要跟着变
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings?.newValue) return;
    settings = withDefaults(changes.settings.newValue);
    applyTheme(settings);
    fillFields();
    renderDisplay();
    renderPolishEngine();
    renderTheme();
  });
}

// ---------- 读取与写入 ----------

async function load() {
  const reply = await send({ type: 'settings.load' }).catch(() => null);
  return reply ?? {};
}

/**
 * 输入框失焦或回车时落盘，不做逐字保存——避免每敲一下就发一次请求。
 * @param {string} path 设置路径，如 llm.baseUrl
 * @param {unknown} value
 */
async function commit(path, value) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  setByPath(patch, path, value);
  if (path === 'llm.baseUrl' || path === 'llm.model') patch.polishEngine = 'custom';
  const reply = await send({ type: 'settings.save', payload: { patch } }).catch(() => null);
  if (reply?.settings) settings = reply.settings;
  if (path === 'llm.baseUrl' || path === 'llm.model') renderPolishEngine();
  if (reply?.notes?.length) {
    for (const text of reply.notes) flash('llm-result', text, null);
  }
  return reply;
}

function renderPolishEngine() {
  byId('llm-engine').replaceChildren(polishEngineRow(settings, (patch) => commit('polishEngine', patch.polishEngine)));
}

function fillFields() {
  for (const [id, path, kind] of FIELDS) {
    const node = field(id);
    // 正在编辑的字段不要被覆盖，否则边打字边落盘时会跳字
    if (!node || document.activeElement === node) continue;
    const value = getByPath(settings, path);
    if (kind === 'bool') {
      if (node instanceof HTMLInputElement) node.checked = Boolean(value);
    } else node.value = String(value ?? '');
    // 密码框不用额外做掩码：type=password 本身就显示成圆点，
    // 已存的密钥既看得见长度又能直接改
  }
}

// ---------- 勾选（与弹窗同源） ----------

function renderDisplay() {
  const rows = byId('display-rows');
  rows.replaceChildren();
  rows.appendChild(
    displayToggleRows({
      settings,
      showPolishLevel: true,
      onChange: (patch) => commitPatch(patch),
      onSetup: () => {},
    }),
  );
  // 这个区块的勾选直接生效，不需要「去设置」按钮
  for (const btn of rows.querySelectorAll('.c2md-check-setup')) btn.remove();
  for (const row of rows.querySelectorAll('.c2md-check')) {
    if (!(row instanceof HTMLElement)) continue;
    row.style.borderBottom = '';
  }
}

/** @param {object} patch 要改的设置（只含改动的字段） */
async function commitPatch(patch) {
  const reply = await send({ type: 'settings.save', payload: { patch } }).catch(() => null);
  if (reply?.settings) settings = reply.settings;
  renderDisplay();
}

// ---------- 转录方式与主题 ----------

function renderTheme() {
  byId('theme-control').replaceChildren(
    segmented({
      options: [
        { value: 'auto', label: '跟随系统' },
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' },
      ],
      value: settings.theme,
      onChange: async (value) => {
        await commit('theme', value);
        applyTheme(settings);
        renderTheme();
      },
    }),
  );
}

// ---------- 动作 ----------

function bindActions() {
  const installer = /** @type {HTMLAnchorElement} */ (byId('helper-install'));
  const version = chrome.runtime.getManifest().version;
  installer.href = `https://github.com/Tchirek/course2md-web/releases/download/v${version}/course2md-helper-${version}.zip`;
  installer.target = '_blank';
  installer.rel = 'noopener';
  installer.addEventListener('click', () => flash('helper-result', '解压安装包，双击「安装本机助手.cmd」，完成后点「检查连接」。', null));
  byId('helper-check').addEventListener('click', async () => {
    flash('helper-result', '正在检查连接', null);
    try { await send({ type: 'helper.check' }); flash('helper-result', '本机助手已连接', true); }
    catch (error) { flash('helper-result', errorText(error), false); }
  });
  for (const [id, path, kind] of FIELDS) {
    const node = field(id);
    if (!node) continue;
    const handler = () => {
      const value = kind === 'bool'
        ? node instanceof HTMLInputElement && node.checked
        : kind === 'number' ? Number(node.value) : node.value;
      commit(path, value);
    };
    if (kind === 'bool') node.addEventListener('change', handler);
    else {
      node.addEventListener('change', handler);
      node.addEventListener('blur', handler);
    }
  }

  byId('llm-grant').addEventListener('click', () => grantFor('llm-url', 'llm-result'));
  byId('asr-grant').addEventListener('click', () => grantFor('asr-endpoint', 'asr-result'));

  byId('llm-test').addEventListener('click', () => test('llm'));
  byId('asr-test').addEventListener('click', () => test('asr'));
  byId('asr-start').addEventListener('click', startLocalAsr);
  byId('llm-local-start').addEventListener('click', startLocalPolish);

  byId('reset').addEventListener('click', async () => {
    const reply = await send({ type: 'settings.reset' }).catch(() => null);
    if (reply) {
      settings = withDefaults(reply);
      applyTheme(settings);
      fillFields();
      renderDisplay();
      renderPolishEngine();
      renderTheme();
      flash('reset-result', '已恢复默认。', true);
    }
  });
}

async function startLocalAsr() {
  const button = buttonById('asr-start');
  button.disabled = true;
  flash('asr-result', '正在启动本机转录服务…', null);
  try {
    const granted = await chrome.permissions.request({ origins: ['http://127.0.0.1:8081/*'] });
    if (!granted) throw new Error('没有授予本机转录端点的访问权限。');
    const status = await send({ type: 'asr.local.start' });
    await commitPatch({ source: 'asr', asr: { endpoint: LOCAL_ASR_ENDPOINT, model: status.model || 'Qwen3-ASR-1.7B', apiKey: '' } });
    fillFields();
    showLocalAsrStatus(status);
  } catch (error) {
    button.disabled = false;
    flash('asr-result', errorText(error), false);
  }
}

async function startLocalPolish() {
  const button = buttonById('llm-local-start');
  button.disabled = true;
  try {
    await commit('polishEngine', 'local');
    renderPolishEngine();
    showLocalPolishStatus(await send({ type: 'polish.local.start' }));
  } catch (error) {
    button.disabled = false;
    flash('llm-local-result', errorText(error), false);
  }
}

/** @param {LocalServiceStatus} status */
function showLocalPolishStatus(status) {
  const running = ['starting', 'installing', 'downloading', 'loading'].includes(status.state);
  const button = buttonById('llm-local-start');
  button.disabled = running;
  button.textContent = status.state === 'ready' ? '本机润色已就绪' : '启用本机润色';
  if (status.state !== 'idle') flash('llm-local-result', status.message, status.state === 'ready' ? true : status.state === 'error' ? false : null);
  if (polishPoll) clearInterval(polishPoll);
  if (running) polishPoll = setInterval(() => {
    send({ type: 'polish.local.status' }).then(showLocalPolishStatus).catch((error) => {
      clearInterval(polishPoll);
      polishPoll = undefined;
      button.disabled = false;
      flash('llm-local-result', errorText(error), false);
    });
  }, 1000);
}

/** @param {LocalServiceStatus} status */
function showLocalAsrStatus(status) {
  const running = ['starting', 'installing', 'downloading', 'loading'].includes(status.state);
  const button = buttonById('asr-start');
  const configured = settings.asr.endpoint === LOCAL_ASR_ENDPOINT;
  button.disabled = running;
  button.textContent = status.state === 'ready' ? configured ? '本机服务已启动 · 检查' : '使用本机转录服务' : '启动本机转录服务';
  if (status.state !== 'idle') flash('asr-result', status.message, status.state === 'ready' ? true : status.state === 'error' ? false : null);
  if (asrPoll) clearInterval(asrPoll);
  if (running) asrPoll = setInterval(() => {
    send({ type: 'asr.local.status' }).then(showLocalAsrStatus).catch((error) => {
      clearInterval(asrPoll);
      asrPoll = undefined;
      button.disabled = false;
      flash('asr-result', errorText(error), false);
    });
  }, 1000);
}

/**
 * 把具体来源加进扩展权限。
 * 必须由用户点击触发——浏览器只允许在用户手势里申请权限。
 * @param {string} inputId 填地址的字段
 * @param {string} resultId 显示结果的位置
 */
async function grantFor(inputId, resultId) {
  const raw = valueOf(inputId).trim();
  if (!raw) {
    flash(resultId, '先填地址，再点授权。', false);
    return;
  }
  let origin;
  try {
    origin = `${new URL(raw).origin}/*`;
  } catch {
    flash(resultId, '地址格式不对，像 https://api.example.com/v1 这样填。', false);
    return;
  }

  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) {
      flash(resultId, `已授权 ${origin}。`, true);
    } else {
      flash(resultId, '没有授权。请求会被浏览器拦掉，除非该服务端自己发了 CORS 头。', false);
    }
  } catch (error) {
    flash(resultId, `授权失败：${errorText(error)}`, false);
  }
}

/** @param {'llm'|'asr'} which */
async function test(which) {
  const resultId = `${which}-result`;
  flash(resultId, '正在测试…', null);

  if (which === 'llm') {
    const payload = {
      baseUrl: valueOf('llm-url').trim(),
      apiKey: valueOf('llm-key'),
      model: valueOf('llm-model').trim(),
    };
    if (!payload.baseUrl) {
      flash(resultId, '先填服务地址。', false);
      return;
    }
    const reply = await send({ type: 'llm.test', payload }).catch((error) => ({
      ok: false,
      message: errorText(error),
    }));
    flash(resultId, reply?.message ?? '没有返回', reply?.ok);
    return;
  }

  const payload = {
    endpoint: valueOf('asr-endpoint').trim(),
    apiKey: valueOf('asr-key'),
    model: valueOf('asr-model').trim(),
  };
  const reply = await send({ type: 'asr.test', payload }).catch((error) => ({
    ok: false,
    message: errorText(error),
  }));
  flash(resultId, [reply?.message, reply?.hint].filter(Boolean).join(' '), reply?.ok);
}

/**
 * 就地显示一条结果。`ok` 为 null 表示进行中。
 * @param {string} id
 * @param {string|undefined} text
 * @param {boolean|null|undefined} ok
 */
function flash(id, text, ok) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text ?? '';
  if (ok === null || ok === undefined) node.removeAttribute('data-ok');
  else node.dataset.ok = String(Boolean(ok));
}

// ---------- 小工具 ----------

/** @param {string} id */
function valueOf(id) {
  return field(id)?.value ?? '';
}

/** @param {unknown} error */
function errorText(error) {
  return String(/** @type {{message?: string}} */ (error)?.message ?? error);
}

/**
 * @param {{type: string, payload?: object}} message
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
 * @param {object} obj
 * @param {string} path 用点分隔的路径
 * @returns {unknown}
 */
function getByPath(obj, path) {
  return path.split('.').reduce((/** @type {any} */ o, key) => (o == null ? undefined : o[key]), obj);
}

/**
 * @param {Record<string, any>} obj
 * @param {string} path 用点分隔的路径，中间缺的层级会补成空对象
 * @param {unknown} value
 */
function setByPath(obj, path, value) {
  const keys = path.split('.');
  const last = /** @type {string} */ (keys.pop());
  const target = keys.reduce((o, key) => (o[key] ??= {}), obj);
  target[last] = value;
  return obj;
}
