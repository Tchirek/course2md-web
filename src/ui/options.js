//! 设置页。
//!
//! 两个关键动作：
//!  - 「授权访问此地址」：把具体来源加进扩展权限。OpenAI 兼容的端点基本都不发
//!    CORS 头，没有这一步，请求会被浏览器拦掉。
//!  - 「测试连接」：真的发一次请求，把服务端的原话带回来，而不是只说「失败」。

import { segmented, displayToggleRows, applyTheme } from './controls.js';
import { withDefaults } from '../core/settings.js';

/** 字段表：DOM id -> 设置路径。声明式绑定，省掉一堆重复的 addEventListener。 */
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

let settings = null;
let asrPoll = null;
let polishPoll = null;
const LOCAL_ASR_ENDPOINT = 'http://127.0.0.1:8081/v1/audio/transcriptions';

init();

async function init() {
  settings = withDefaults(await load());
  applyTheme(settings);
  fillFields();
  renderDisplay();
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
    renderTheme();
  });
}

// ---------- 读取与写入 ----------

async function load() {
  const reply = await send({ type: 'settings.load' }).catch(() => null);
  return reply ?? {};
}

/** 输入框失焦或回车时落盘，不做逐字保存——避免每敲一下就发一次请求。 */
async function commit(path, value) {
  const patch = {};
  setByPath(patch, path, value);
  const reply = await send({ type: 'settings.save', payload: { patch } }).catch(() => null);
  if (reply?.settings) settings = reply.settings;
  if (reply?.notes?.length) {
    for (const text of reply.notes) flash('llm-result', text, null);
  }
  return reply;
}

function fillFields() {
  for (const [id, path, kind] of FIELDS) {
    const node = document.getElementById(id);
    // 正在编辑的字段不要被覆盖，否则边打字边落盘时会跳字
    if (!node || document.activeElement === node) continue;
    const value = getByPath(settings, path);
    if (kind === 'bool') node.checked = Boolean(value);
    else node.value = value ?? '';
    // 密码框不用额外做掩码：type=password 本身就显示成圆点，
    // 已存的密钥既看得见长度又能直接改
  }
}

// ---------- 勾选（与弹窗同源） ----------

function renderDisplay() {
  const rows = document.getElementById('display-rows');
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
    row.style.borderBottom = '';
  }
}

async function commitPatch(patch) {
  const reply = await send({ type: 'settings.save', payload: { patch } }).catch(() => null);
  if (reply?.settings) settings = reply.settings;
  renderDisplay();
}

// ---------- 转录方式与主题 ----------

function renderTheme() {
  const host = document.getElementById('theme-control');
  host.replaceChildren(
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
  for (const [id, path, kind] of FIELDS) {
    const node = document.getElementById(id);
    if (!node) continue;
    const handler = () => {
      const value =
        kind === 'bool' ? node.checked : kind === 'number' ? Number(node.value) : node.value;
      commit(path, value);
    };
    if (kind === 'bool') node.addEventListener('change', handler);
    else {
      node.addEventListener('change', handler);
      node.addEventListener('blur', handler);
    }
  }

  document.getElementById('llm-grant').addEventListener('click', () => grantFor('llm-url', 'llm-result'));
  document.getElementById('asr-grant').addEventListener('click', () => grantFor('asr-endpoint', 'asr-result'));

  document.getElementById('llm-test').addEventListener('click', () => test('llm'));
  document.getElementById('asr-test').addEventListener('click', () => test('asr'));
  document.getElementById('asr-start').addEventListener('click', startLocalAsr);
  document.getElementById('llm-local-start').addEventListener('click', startLocalPolish);

  document.getElementById('reset').addEventListener('click', async () => {
    const reply = await send({ type: 'settings.reset' }).catch(() => null);
    if (reply) {
      settings = withDefaults(reply);
      applyTheme(settings);
      fillFields();
      renderDisplay();
      renderTheme();
      flash('reset-result', '已恢复默认。', true);
    }
  });
}

async function startLocalAsr() {
  const button = document.getElementById('asr-start');
  button.disabled = true;
  flash('asr-result', '正在启动本机转录服务…', null);
  try {
    const granted = await chrome.permissions.request({ origins: ['http://127.0.0.1:8081/*'] });
    if (!granted) throw new Error('没有授予本机转录端点的访问权限。');
    const status = await send({ type: 'asr.local.start' });
    await commitPatch({ source: 'asr', asr: { endpoint: LOCAL_ASR_ENDPOINT, model: 'small', apiKey: '' } });
    fillFields();
    showLocalAsrStatus(status);
  } catch (error) {
    button.disabled = false;
    flash('asr-result', String(error?.message ?? error), false);
  }
}

async function startLocalPolish() {
  const button = document.getElementById('llm-local-start');
  button.disabled = true;
  try {
    showLocalPolishStatus(await send({ type: 'polish.local.start' }));
  } catch (error) {
    button.disabled = false;
    flash('llm-local-result', String(error?.message ?? error), false);
  }
}

function showLocalPolishStatus(status) {
  const running = ['starting', 'installing', 'downloading', 'loading'].includes(status.state);
  const button = document.getElementById('llm-local-start');
  button.disabled = running;
  button.textContent = status.state === 'ready' ? '本机润色已就绪' : '启用本机润色';
  if (status.state !== 'idle') flash('llm-local-result', status.message, status.state === 'ready' ? true : status.state === 'error' ? false : null);
  if (polishPoll) clearInterval(polishPoll);
  if (running) polishPoll = setInterval(() => {
    send({ type: 'polish.local.status' }).then(showLocalPolishStatus).catch((error) => {
      clearInterval(polishPoll);
      polishPoll = null;
      button.disabled = false;
      flash('llm-local-result', String(error?.message ?? error), false);
    });
  }, 1000);
}

function showLocalAsrStatus(status) {
  const running = ['starting', 'downloading', 'loading'].includes(status.state);
  const button = document.getElementById('asr-start');
  const configured = settings.asr.endpoint === LOCAL_ASR_ENDPOINT && settings.asr.model === 'small';
  button.disabled = running;
  button.textContent = status.state === 'ready' ? configured ? '本机服务已启动 · 检查' : '使用本机转录服务' : '启动本机转录服务';
  if (status.state !== 'idle') flash('asr-result', status.message, status.state === 'ready' ? true : status.state === 'error' ? false : null);
  if (asrPoll) clearInterval(asrPoll);
  if (running) asrPoll = setInterval(() => {
    send({ type: 'asr.local.status' }).then(showLocalAsrStatus).catch((error) => {
      clearInterval(asrPoll);
      asrPoll = null;
      button.disabled = false;
      flash('asr-result', String(error?.message ?? error), false);
    });
  }, 1000);
}

/**
 * 把具体来源加进扩展权限。
 * 必须由用户点击触发——浏览器只允许在用户手势里申请权限。
 */
async function grantFor(inputId, resultId) {
  const raw = document.getElementById(inputId).value.trim();
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
    flash(resultId, `授权失败：${String(error?.message ?? error)}`, false);
  }
}

async function test(which) {
  const resultId = `${which}-result`;
  flash(resultId, '正在测试…', null);

  if (which === 'llm') {
    const payload = {
      baseUrl: document.getElementById('llm-url').value.trim(),
      apiKey: document.getElementById('llm-key').value,
      model: document.getElementById('llm-model').value.trim(),
    };
    if (!payload.baseUrl) {
      flash(resultId, '先填服务地址。', false);
      return;
    }
    const reply = await send({ type: 'llm.test', payload }).catch((error) => ({
      ok: false,
      message: String(error?.message ?? error),
    }));
    flash(resultId, reply?.message ?? '没有返回', reply?.ok);
    return;
  }

  const payload = {
    endpoint: document.getElementById('asr-endpoint').value.trim(),
    apiKey: document.getElementById('asr-key').value,
    model: document.getElementById('asr-model').value.trim(),
  };
  const reply = await send({ type: 'asr.test', payload }).catch((error) => ({
    ok: false,
    message: String(error?.message ?? error),
  }));
  flash(resultId, [reply?.message, reply?.hint].filter(Boolean).join(' '), reply?.ok);
}

/** 就地显示一条结果。`ok` 为 null 表示进行中。 */
function flash(id, text, ok) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text ?? '';
  if (ok === null || ok === undefined) node.removeAttribute('data-ok');
  else node.dataset.ok = String(Boolean(ok));
}

// ---------- 小工具 ----------

function send(message) {
  return chrome.runtime.sendMessage(message).then((reply) => {
    if (!reply) throw new Error('扩展后台没有响应');
    if (!reply.ok) throw new Error(reply.error ?? '未知错误');
    return reply.value;
  });
}

function getByPath(obj, path) {
  return path.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);
}

function setByPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, key) => (o[key] ??= {}), obj);
  target[last] = value;
  return obj;
}
