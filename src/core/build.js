//! 拡張のコードの指紋。解凍して読み込んだ拡張は、ファイルを更新しても後台（service worker）が
//! 古いコードのまま動き続ける。一方でポップアップや内容スクリプトはディスク上の新しいコードを読む。
//! この食い違い（例：新しい本機助手はトークンを求めるのに、古い後台はトークンを送らず 401）を
//! 見つけるため、後台の起動時の指紋とディスク上の現在の指紋を比べる。

const ENTRY = 'src/background/sw.js';

/**
 * manifest.json と後台のモジュール閉包（sw.js から静的・動的 import をたどった全ファイル）の
 * 内容から SHA-256 を作る。後台のどのファイルが変わっても指紋が変わる。
 * @returns {Promise<string>}
 */
export async function codeFingerprint() {
  const seen = new Map();
  const queue = [chrome.runtime.getURL(ENTRY)];
  for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
    if (seen.has(url)) continue;
    const text = await (await fetch(url, { cache: 'no-store' })).text();
    seen.set(url, text);
    for (const [, from, dynamic] of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = from ?? dynamic;
      if (specifier?.startsWith('.')) queue.push(new URL(specifier, url).href);
    }
  }
  const manifest = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).text();
  const joined = [manifest, ...[...seen.keys()].sort().map((url) => `${url}\n${seen.get(url)}`)].join('\n\0\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** ストアからではなく解凍して読み込まれた拡張か（ストア版の更新はブラウザが面倒を見る）。 */
export function isUnpacked() {
  return !('update_url' in chrome.runtime.getManifest());
}

/**
 * 拡張が（再）読み込みされた瞬間の指紋を記録する。onInstalled はそのときにしか来ないので、
 * このときディスク上のコードがそのまま動いているコードになる（後台が回収されて再起動しても、
 * 動くのは読み込み時のコードで、ディスクを読み直しても手がかりにならない）。
 */
export async function recordLoadedCode() {
  await chrome.storage.local.set({ loadedCode: await codeFingerprint() });
}

/**
 * ディスク上のコードが読み込み時から変わっているか。記録が無い（指紋を記録しない旧版で
 * 読み込まれた）ときも変わったとみなす。循環しないよう、直前 60 秒に読み込み直していれば false。
 */
export async function codeIsStale() {
  if (!isUnpacked()) return false;
  const { loadedCode, lastCodeReload = 0 } = await chrome.storage.local.get(['loadedCode', 'lastCodeReload']);
  if (Date.now() - Number(lastCodeReload) < 60_000) return false;
  return loadedCode !== await codeFingerprint();
}

/** 古ければ拡張を読み込み直す。直すなら true。 */
export async function reloadIfCodeChanged() {
  if (!await codeIsStale()) return false;
  await chrome.storage.local.set({ lastCodeReload: Date.now() });
  chrome.runtime.reload();
  return true;
}
