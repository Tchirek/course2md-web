//! 设置的存取。全部落 chrome.storage.local（见 core/settings.js 的说明）。

import { DEFAULT_SETTINGS, withDefaults, normalizeSettings } from '../core/settings.js';

const KEY = 'settings';

/** @returns {Promise<object>} 已补齐默认值的设置 */
export async function loadSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return withDefaults(stored?.[KEY]);
}

/**
 * 存设置。返回归一化后的结果与需要提醒用户的问题。
 * @param {object} patch 与现有设置深合并
 */
export async function saveSettings(patch) {
  const current = await loadSettings();
  const { settings, notes } = normalizeSettings(deepMerge(current, patch));
  await chrome.storage.local.set({ [KEY]: settings });
  return { settings, notes };
}

export async function resetSettings() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ [KEY]: settings });
  return settings;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
    ) {
      deepMerge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** 设置变化广播给所有打开的标签页与弹窗，让 UI 立刻跟上。 */
export function onSettingsChanged(handler) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    handler(withDefaults(changes[KEY].newValue));
  });
}
