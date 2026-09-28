//! 内容脚本入口（声明式注入的那份）。
//!
//! 内容脚本不能用 ESM 的静态 import，所以这里只做一件事：动态导入真正的
//! 控制器。这样所有模块仍然是可读的、可单测的 ESM，不需要打包器。
//! 用动态 import 而不是把几百行塞进一个文件，是 MV3 下最省事又最干净的做法。

(async () => {
  // 双重注入防护：声明式与弹窗主动注入可能都触发，只认第一次
  if (window.__c2mdBooted) return;
  window.__c2mdBooted = true;
  try {
    const mod = await import(chrome.runtime.getURL('src/content/content.js'));
    await mod.start();
  } catch (error) {
    console.error('[course2md] 启动失败', error);
  }
})();
