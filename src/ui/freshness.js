//! 隐藏在页面里的扩展小页面：检查扩展代码是否已在磁盘上更新而后台仍是旧的。
//!
//! 内容脚本无权重新加载扩展，而旧后台未必认得新消息；扩展自己的页面总是读取磁盘上的
//! 新代码、又有完整的扩展权限，所以由它来查、来重载。

import { codeIsStale } from '../core/build.js';

(async () => {
  let stale = false;
  try {
    stale = await codeIsStale();
    if (stale) await chrome.storage.local.set({ lastCodeReload: Date.now() });
  } catch {
    stale = false;
  }
  parent.postMessage({ channel: 'c2md-freshness', reloading: stale }, '*');
  // 重载会立刻销毁本页，所以先答复页面，再重载
  if (stale) setTimeout(() => chrome.runtime.reload(), 100);
})();
