//! 设置：默认值、校验、归一化。
//!
//! 全部存在 chrome.storage.local，**不**用 storage.sync。
//! sync 会把内容上传到浏览器厂商的服务器，而这里必然要放 API key——
//! 一个跳转开关不值得拿密钥去换。

export const DEFAULT_SETTINGS = {
  /** 文字来源：'subtitle' 平台字幕 | 'asr' 本地模型转录 */
  source: 'subtitle',

  // —— 显示与处理 ——
  /** 显示每句被讲述的时刻 */
  showTimestamps: true,
  /** 图片密度：none | few | default | many */
  imageLevel: 'default',
  /** 润色文本（需用户自行接入 LLM） */
  polish: false,
  polishLevel: 'standard',

  /** 打开页面时自动抓取并生成（默认关闭，避免误发请求） */
  autoRun: false,
  /** 生成后自动展开页面内面板 */
  showPanel: true,

  subtitle: {
    /** 首选语言代码（'' = 跟随页面/自动挑选） */
    preferLang: '',
    /** 没有人工字幕时是否接受自动生成的字幕 */
    allowAuto: true,
  },

  asr: {
    /** 本机 ASR 服务的 OpenAI 兼容转写端点。 */
    endpoint: 'http://127.0.0.1:8081/v1/audio/transcriptions',
    apiKey: '',
    model: 'whisper-1',
    /** 语言提示（'' = 自动） */
    language: '',
    /** 送入 ASR 的音频切片长度（秒） */
    chunkSeconds: 30,
    /** 仅用于播放器录音回退；大于 1 会变调，默认不动。 */
    playbackRate: 1,
  },

  llm: {
    /** OpenAI 兼容的 chat/completions 基址，如 https://api.deepseek.com/v1 */
    baseUrl: '',
    apiKey: '',
    model: '',
    /** 自定义校对指令（'' = 用内置默认） */
    instruction: '',
    /** 术语表，每行一条；用于纠正专有名词拼写 */
    glossary: '',
    /** 并发块数 */
    concurrency: 4,
    /** 带进下一块的只读上下文字数 */
    contextChars: 160,
  },

  /** 'auto' | 'light' | 'dark' */
  theme: 'auto',
};

/** 深合并默认值，保证读到的设置永远字段齐全。 */
export function withDefaults(stored) {
  const settings = deepMerge(structuredClone(DEFAULT_SETTINGS), stored ?? {});
  delete settings.clickToSeek; // 旧版开关由 showTimestamps 取代
  if (settings.asr.endpoint === 'http://127.0.0.1:8080/v1/audio/transcriptions' && settings.asr.model === 'small') {
    settings.asr.endpoint = DEFAULT_SETTINGS.asr.endpoint;
  }
  return settings;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      deepMerge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/**
 * 归一化并夹取用户输入。存前调用一次，坏值不会进存储。
 * 返回值同时带 `ok` 与 `notes`，供设置页把问题说清楚。
 * @param {object} raw
 */
export function normalizeSettings(raw) {
  const s = withDefaults(raw);
  const notes = [];

  s.source = s.source === 'asr' ? 'asr' : 'subtitle';
  s.theme = ['light', 'dark', 'auto'].includes(s.theme) ? s.theme : 'auto';
  s.imageLevel = ['none', 'few', 'default', 'many'].includes(s.imageLevel) ? s.imageLevel : 'default';
  s.polishLevel = ['light', 'standard', 'deep'].includes(s.polishLevel) ? s.polishLevel : 'standard';

  s.llm.baseUrl = String(s.llm.baseUrl ?? '').trim().replace(/\/+$/, '');
  s.llm.apiKey = String(s.llm.apiKey ?? '').trim();
  s.llm.model = String(s.llm.model ?? '').trim();
  s.llm.concurrency = clampInt(s.llm.concurrency, 1, 16, 4);
  s.llm.contextChars = clampInt(s.llm.contextChars, 0, 600, 160);

  s.asr.endpoint = String(s.asr.endpoint ?? '').trim();
  s.asr.model = String(s.asr.model ?? '').trim();
  s.asr.chunkSeconds = clampInt(s.asr.chunkSeconds, 5, 120, 30);
  s.asr.playbackRate = clampInt(s.asr.playbackRate, 1, 16, 1);
  s.subtitle.preferLang = String(s.subtitle.preferLang ?? '').trim();

  if (s.source === 'asr' && !isHttpUrl(s.asr.endpoint)) {
    notes.push('本地模型转录需要填写本机 ASR 服务的地址，否则转录会失败。');
  }

  return { settings: s, notes };
}

/** 润色是否具备可运行的条件。 */
export function canPolish(s) {
  return Boolean(s.polish && isHttpUrl(s.llm.baseUrl) && s.llm.model);
}

/** ASR 是否具备可运行的条件。 */
export function canTranscribe(s) {
  if (s.source !== 'asr') return true;
  return isHttpUrl(s.asr.endpoint);
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 设置里需要脱敏展示的字段。 */
export const SECRET_KEYS = ['llm.apiKey', 'asr.apiKey'];

/** 取嵌套字段。 */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 以 'a.b.c' 路径写值（就地修改）。 */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
  return obj;
}

/** 脱敏：只留尾 4 位。 */
export function maskSecret(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}
