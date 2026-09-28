//! 面板自测：把真实的面板组件挂到假页面上，渲染几种状态供目视校验。
//! 这个文件只在 chrome-extension://<id>/tools/selftest-panel.html 里跑，
//! 所以 chrome.* API 是真的，只有数据是假的。

import { Panel } from '../src/content/panel.js';
import { organize, finalize } from '../src/content/pipeline.js';
import { polishSegments } from '../src/content/pipeline.js';
import { applyPolish } from '../src/core/prompt.js';
import { withDefaults } from '../src/core/settings.js';
import { EVENTS, META, POLISHED } from './fixtures.js';

const params = new URLSearchParams(location.search);
/** ?state=ready|running|error|empty|polished|nopolish */
const scenario = params.get('state') ?? 'ready';
/** 面板宽度可在 URL 上覆盖，方便看窄屏表现 */
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme');

const settings = withDefaults({
  showTimestamps: params.get('ts') !== 'off',
  imageLevel: 'default',
  polish: scenario === 'polished',
  theme: params.get('theme') ?? 'auto',
  // 已润色却不接 LLM 是自相矛盾的状态，截图里会同时出现「已润色」和「去设置」。
  // 造数据就把 LLM 也算上，让这个场景自洽。
  llm:
    scenario === 'polished'
      ? { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
      : {},
});

const panel = new Panel({
  onSettings: () => {},
  onSeek: (sec) => {
    // 假页面没有真播放器，把跳转结果写到控制台，顺便让段落闪一下
    console.log('[selftest] seek ->', sec);
  },
  onCopy: () => {},
  onCopyText: () => {},
  onDownload: () => {},
  onRerun: () => {},
  onRepolish: () => {},
  onOptions: () => {},
  onClose: () => panel.unmount(),
  onSwitchToAsr: () => {},
});

// 用真实管线把假事件组织成分节与段落——不是手摆的 DOM
const organized = organize(EVENTS, META, {});
const built = {
  ...organized,
  stats: {
    source: 'subtitle',
    trackLabel: '简体中文 · 人工上传',
    eventCount: EVENTS.length,
  },
  warnings: [],
};
const doc = finalize(built, META, settings);

const base = {
  settings,
  meta: META,
  sections: built.sections,
  stats: built.stats,
  warnings: [],
};

if (scenario === 'polished') {
  // 用真实的写回逻辑造出「已润色」的段落，验证原文/润色文切换
  const ids = built.segments.map((_, i) => i);
  const polished = ids
    .filter((i) => POLISHED[i] !== undefined)
    .map((i) => ({ id: i, text: POLISHED[i] }));
  applyPolish(built.segments, ids.slice(0, polished.length), polished);
  built.segments[1].state = 'skipped';
}

if (scenario === 'running') {
  panel.mount();
  panel.setState({
    ...base,
    status: 'running',
    stageLabel: '正在从视频音轨录制并转写',
    polish: { running: true, done: 3, total: 11 },
  });
} else if (scenario === 'error') {
  panel.mount();
  panel.setState({
    ...base,
    sections: [],
    status: 'error',
    error: {
      title: '取不到文字',
      body: '这个页面没有可用的字幕。可以在「文字来源」里改成「本地模型转录」，用本机模型从音频转写。',
      switchToAsr: true,
    },
  });
} else if (scenario === 'empty') {
  panel.mount();
  panel.setState({ ...base, sections: [], status: 'idle' });
} else {
  panel.mount();
  panel.setState({
    ...base,
    status: 'ready',
    polish:
      scenario === 'polished'
        ? { hasResult: true, running: false, done: 11, total: 11 }
        : null,
  });
}

// 供截图脚本确认渲染完成
window.__selftestReady = true;
window.__selftestPanel = panel;
document.title = `面板自测 · ${scenario}`;
