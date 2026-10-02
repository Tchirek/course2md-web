//! 清单自检：manifest 引用的每个文件都必须在，动态 import 的模块必须能被页面取到。
//!
//! 为什么需要它：manifest 里写错一个路径，Chrome 只会让那个部件静默失效——不报错、
//! 不提示，直到用户发现按钮点了没反应。而内容脚本用 `import(chrome.runtime.getURL(…))`
//! 动态加载的模块不在 manifest 里出现，`web_accessible_resources` 覆盖不到就会在运行
//! 时报 CORS 错——这也是 manifest 静态检查发现不了的。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const ok = [];

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let manifest;
try {
  manifest = JSON.parse(read('manifest.json'));
} catch (error) {
  console.error(`manifest.json 不是合法 JSON：${error.message}`);
  process.exit(1);
}

const require_ = (rel, why) => {
  if (existsSync(join(ROOT, rel))) ok.push(`${rel}（${why}）`);
  else problems.push(`缺文件：${rel}（${why}）`);
};

// ---------- 1. manifest 直接引用的文件 ----------
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  require_(path, `图标 ${size}`);
}
for (const [size, path] of Object.entries(manifest.action?.default_icon ?? {})) {
  require_(path, `工具栏图标 ${size}`);
}
require_(manifest.action?.default_popup, '弹窗页面');
require_(manifest.options_ui?.page, '设置页');
require_(manifest.background?.service_worker, '服务 worker');
for (const cs of manifest.content_scripts ?? []) {
  for (const file of cs.js ?? []) require_(file, '内容脚本');
  for (const file of cs.css ?? []) require_(file, '内容脚本样式');
}

// ---------- 2. 运行时动态 import 的模块 ----------
const dynamicModules = [];
for (const dir of ['src/core', 'src/adapters', 'src/content', 'src/ui']) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const file of readdirSync(abs)) {
    if (file.endsWith('.js')) dynamicModules.push(`${dir}/${file}`);
  }
}
for (const file of dynamicModules) require_(file, '运行时模块');

const patterns = (manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []);
const globToRe = (glob) => {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
};

// ---------- 3. web_accessible_resources 是否能覆盖内容脚本的模块闭包 ----------
// 内容脚本的源是页面，它动态 import 的每一个 URL 都必须落在 web_accessible_resources
// 里，否则会被当成跨源请求拦掉。
//
// 注意范围：只有**从内容脚本出发可达**的模块需要这个待遇。popup.js / options.js 是
// 扩展页面自己加载的，扩展源内同源，不需要——把它们也算进来会误报，进而诱使人把
// WAR 放宽到没有必要的程度。
const entry = 'src/content/boot.js';
const closure = new Set();
/** Non-module files the content scripts put into the page (stylesheets, the freshness iframe). */
const pageLoaded = new Set();
const queue = [entry];
while (queue.length) {
  const file = queue.shift();
  if (closure.has(file) || !existsSync(join(ROOT, file))) continue;
  closure.add(file);
  const text = read(file);

  // 静态 import/export ... from '...'
  for (const m of text.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    push(m[1]);
  }
  // 裸 import '...'
  for (const m of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) push(m[1]);
  // 动态 import('...')
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1]);
  // 内容脚本的入口用 import(chrome.runtime.getURL('<扩展内路径>')) 加载
  for (const m of text.matchAll(/chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    push(m[1]);
  }

  function push(spec) {
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('src/')) return;
    const resolved = spec.startsWith('.')
      ? join(dirname(file), spec).replace(/\\/g, '/')
      : spec.replace(/^\//, '');
    if (!resolved.endsWith('.js')) {
      // Stylesheets and pages the content script hands to the page by URL. An extension page
      // loaded that way (freshness.html) fetches its own scripts from the extension's origin,
      // so those scripts need no exposure.
      pageLoaded.add(resolved);
      return;
    }
    if (!closure.has(resolved) && existsSync(join(ROOT, resolved))) queue.push(resolved);
  }
}

// boot.js はブラウザが注入する。ページから取得するモジュールではない。
const needAccess = [...closure].filter((file) => file !== entry).concat([...pageLoaded]);
for (const file of needAccess) {
  require_(file, 'ページから取得する資源');
  if (patterns.some((p) => globToRe(p).test(file))) ok.push(`${file} 可被页面取到`);
  else problems.push(`web_accessible_resources 覆盖不到：${file}（内容脚本会在跨源时被拦）`);
}
// The other direction: every exposed entry must be something a page actually loads. Anything
// else is fingerprinting surface for nothing (freshness.js and the popup/options CSS used to be).
const allFiles = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((item) =>
  item.isDirectory() ? allFiles(`${dir}/${item.name}`) : [`${dir}/${item.name}`]);
for (const file of allFiles('src')) {
  if (patterns.some((pattern) => globToRe(pattern).test(file)) && !needAccess.includes(file)) {
    problems.push(`web_accessible_resources 暴露了页面用不到的 ${file}`);
  }
}
for (const pattern of patterns) {
  if (!needAccess.some((file) => globToRe(pattern).test(file))) problems.push(`web_accessible_resources 多余条目：${pattern}`);
}
// use_dynamic_url would stop sites from probing the extension, but it cannot work with ES
// modules: measured on Chrome 154, runtime.getURL returns the per-session URL, yet every
// relative import inside a module loaded from it resolves against the static ID and is
// refused ("Denying load of chrome-extension://<id>/src/..."), so the content script never
// starts. Narrowing WAR reduces exposure, but a site knowing the static ID can still probe it.
for (const w of manifest.web_accessible_resources ?? []) {
  if (w.use_dynamic_url) problems.push('web_accessible_resources 不能开 use_dynamic_url：模块里的相对 import 会按静态 ID 解析而被拦，内容脚本起不来');
}
console.log(`内容脚本模块闭包：${closure.size} 个文件`);

// ---------- 4. 内容脚本不能是 ESM ----------
// 声明式内容脚本是经典脚本，出现顶层 import/export 会直接语法报错。
for (const cs of manifest.content_scripts ?? []) {
  for (const file of cs.js ?? []) {
    if (/^\s*(import|export)\b/m.test(read(file))) {
      problems.push(`${file} 含顶层 import/export，但内容脚本必须是经典脚本`);
    }
  }
}

// ---------- 5. 权限与 API 的对应关系（双向） ----------
// 宣言した権限はすべて用途を登録し、その用途のコードが実在することを確かめる（使っていない
// 権限を残さない）。逆に API を使っていれば権限の宣言を求める。走査はポップアップと設定
// ページを含む拡張の全コードが対象（chrome.scripting はポップアップにしか無い）。
const perms = new Set(manifest.permissions ?? []);
const listJs = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = `${dir}/${entry.name}`;
  if (entry.isDirectory()) return rel === 'src/vendor' ? [] : listJs(rel);
  return entry.name.endsWith('.js') ? [rel] : [];
});
const sources = listJs('src').map((file) => ({ file, text: read(file) }));
const PERMISSION_USES = {
  storage: { needles: ['chrome.storage'], why: '设置与缓存' },
  activeTab: { needles: ['chrome.scripting.executeScript'], why: '在用户点开弹窗的当前页注入内容脚本' },
  scripting: { needles: ['chrome.scripting'], why: '在其他页面按需注入内容脚本' },
  downloads: { needles: ['chrome.downloads'], why: '保存 .md 文件' },
  cookies: { needles: ['chrome.cookies'], why: '向 MizoreLink 提供当前站点登录态' },
  nativeMessaging: { needles: ['sendNativeMessage', 'connectNative'], why: '经本机宿主唤醒 MizoreLink 并取得访问令牌' },
  clipboardWrite: { needles: ["execCommand('copy')"], why: '从弹窗触发复制时页面没有用户激活，execCommand 需要此权限' },
};
for (const [perm, { needles, why }] of Object.entries(PERMISSION_USES)) {
  const hit = sources.find((s) => needles.some((needle) => s.text.includes(needle)));
  if (hit && perms.has(perm)) ok.push(`${perm} 权限：${why}（${hit.file}）`);
  else if (hit) problems.push(`${hit.file} 用了 ${needles[0]}，但没申请 ${perm} 权限（${why}）`);
  else if (perms.has(perm)) problems.push(`申请了 ${perm} 权限，但代码里没有用到（登记的用途：${why}）`);
}
for (const perm of perms) {
  if (!PERMISSION_USES[perm]) problems.push(`权限 ${perm} 没有登记用途：新增权限要在 check-manifest.mjs 的 PERMISSION_USES 里写明理由`);
}

// ---------- 6. MV3 不允许远程代码 ----------
// 只要出现远程 URL 的 script 加载就是在违反 MV3。
for (const { file, text } of sources) {
  if (/<script[^>]+src\s*=\s*["']https?:/i.test(text)) {
    problems.push(`${file} 引用了远程脚本，MV3 禁止`);
  }
}

console.log(`检查项：${ok.length + problems.length}`);
if (problems.length) {
  console.log('\n问题：');
  for (const p of problems) console.log(`  FAIL ${p}`);
  process.exitCode = 1;
} else {
  console.log('全部通过。');
}
