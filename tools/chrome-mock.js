//! chrome.* API 的开发替身，由 tools/serve.mjs 注入到页面里。
//!
//! 只实现界面真正用到的那几个面：storage、runtime（getURL / sendMessage /
//! onMessage / openOptionsPage）、tabs、permissions。行为尽量照着真实语义写，
//! 否则界面上会看到假象——比如 sendMessage 该返回 {ok, value} 包装，
//! 这里就不省。

(() => {
  if (window.chrome?.runtime?.getURL) return; // 真的扩展环境，别覆盖

  const DEFAULTS = {
    source: 'subtitle',
    showTimestamps: true,
    imageLevel: 'default',
    polish: false,
    polishLevel: 'standard',
    polishEngine: 'auto',
    showPanel: true,
    subtitle: { preferLang: '', allowAuto: true },
    asr: { endpoint: 'cli',
      apiKey: '',
      model: 'whisper-1',
      language: '',
      chunkSeconds: 30,
      playbackRate: 1,
    },
    llm: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-demo-not-a-real-key-0000',
      model: 'deepseek-chat',
      instruction: '',
      glossary: 'Transformer\n多头注意力（MHA）',
      concurrency: 4,
      contextChars: 160,
    },
    theme: 'auto',
  };

  // 允许用查询串覆盖设置，方便截某一种状态
  const params = new URLSearchParams(location.search);
  const store = { settings: structuredClone(DEFAULTS) };
  if (params.get('polish') === 'on') store.settings.polish = true;
  if (params.get('ts') === 'off') {
    store.settings.showTimestamps = false;
  }
  if (params.get('theme')) store.settings.theme = params.get('theme');
  if (params.get('nollm') === 'on') {
    store.settings.llm.baseUrl = '';
    store.settings.llm.model = '';
  }
  if (params.get('noasr') === 'on') store.settings.asr.endpoint = '';

  const changeListeners = [];
  const messageListeners = [];

  const storage = {
    local: {
      async get(key) {
        if (key == null) return structuredClone(store);
        if (typeof key === 'string') return { [key]: structuredClone(store[key]) };
        const out = {};
        for (const k of key) out[k] = structuredClone(store[k]);
        return out;
      },
      async set(patch) {
        const changes = {};
        for (const [k, v] of Object.entries(patch)) {
          changes[k] = { oldValue: store[k], newValue: v };
          store[k] = v;
        }
        for (const fn of changeListeners) fn(changes, 'local');
      },
    },
    session: {
      _data: {},
      async get(key) {
        return key == null ? { ...this._data } : { [key]: this._data[key] };
      },
      async set(patch) {
        Object.assign(this._data, patch);
      },
    },
    onChanged: {
      addListener: (fn) => changeListeners.push(fn),
      removeListener: (fn) => {
        const i = changeListeners.indexOf(fn);
        if (i >= 0) changeListeners.splice(i, 1);
      },
    },
  };

  const settingsStatus = {
    status: 'ready',
    site: 'youtube',
    siteLabel: 'YouTube',
    settings: store.settings,
    meta: {
      title: '注意力机制与 Transformer 入门 · 第一讲',
      uploader: '张老师',
      duration: 3725,
      url: location.origin + '/watch?v=dQw4w9WgXcQ',
    },
    stats: { source: 'subtitle', trackLabel: '简体中文 · 人工上传', eventCount: 22 },
    segmented: 10,
    polish: { hasResult: false, running: false, done: 0, total: 0, summary: '' },
    error: null,
    warnings: [],
    stageLabel: '',
  };
  if (params.get('status') === 'running') {
    settingsStatus.status = 'running';
    settingsStatus.stageLabel = '正在取字幕：简体中文 · 人工上传';
    settingsStatus.stats = null;
    settingsStatus.segmented = 0;
  }

  // 真实后台返回 normalizeSettings 之后的完整设置；替身也要补齐默认字段，
  // 否则界面会拿到缺 polishLevel 之类的残缺对象，看到假象。
  const withDefaults = (value) => {
    const out = structuredClone(DEFAULTS);
    const merge = (base, patch) => {
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
        else base[k] = v;
      }
    };
    merge(out, value);
    return out;
  };

  const chromeMock = {
    runtime: {
      // 相对扩展根目录解析，与真实语义一致：'/src/ui/tokens.css'
      getURL: (path) => new URL(String(path).replace(/^\.?\//, ''), location.origin + '/').toString(),
      id: 'selftest-mock-extension-id',
      async sendMessage(message) {
        const type = message?.type;
        if (type === 'settings.load') return { ok: true, value: withDefaults(store.settings) };
        if (type === 'settings.save') {
          const patch = message.payload?.patch ?? {};
          deepMerge(store.settings, patch);
          for (const fn of changeListeners) {
            fn({ settings: { newValue: withDefaults(store.settings) } }, 'local');
          }
          return { ok: true, value: { settings: withDefaults(store.settings), notes: [] } };
        }
        if (type === 'settings.reset') {
          store.settings = structuredClone(DEFAULTS);
          return { ok: true, value: withDefaults(store.settings) };
        }
        if (type === 'llm.test') {
          return {
            ok: true,
            value: { ok: true, message: '端点可用，共 12 个模型。' },
          };
        }
        if (type === 'asr.test') {
          return {
            ok: true,
            value: { ok: true, message: '转写请求成功，服务可用。' },
          };
        }
        if (/^(asr|polish)\.local\.(start|status)$/.test(type)) {
          return { ok: true, value: { state: 'ready', message: 'CLI 已连接 · 模型按需准备', model: type.startsWith('asr') ? 'Qwen3-ASR-1.7B' : 'test-llm' } };
        }
        if (type === 'desktop.publish') return { ok: true, value: { saved: true, course: 'demo', version: 'web-demo' } };
        if (type === 'file.save') return { ok: true, value: { filename: 'notes.md' } };
        return { ok: true, value: null };
      },
      onMessage: {
        addListener: (fn) => messageListeners.push(fn),
        removeListener: () => {},
      },
      openOptionsPage: () => {
        window.open('/src/ui/options.html', '_blank');
      },
    },
    storage,
    tabs: {
      async query() {
        // 给一个真实的站点形态，这样弹窗渲染的是「已支持站点」那一支
        return [
          {
            id: 1,
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            title: '注意力机制与 Transformer 入门 · 第一讲',
          },
        ];
      },
      async sendMessage() {
        return { ok: true, value: structuredClone(settingsStatus) };
      },
    },
    permissions: {
      async request() {
        return true;
      },
      async contains() {
        return true;
      },
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
    downloads: {
      async download() {
        return 1;
      },
    },
  };

  /** 只暴露给自测页用，方便在控制台里改设置看效果。 */
  chromeMock.__mock = { store, settingsStatus, changeListeners,
    emitState: (payload) => messageListeners.forEach((fn) => fn({ type: 'c2md.state', payload })),
  };

  window.chrome = chromeMock;

  function deepMerge(base, patch) {
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
        deepMerge(base[k], v);
      } else {
        base[k] = v;
      }
    }
    return base;
  }
})();
