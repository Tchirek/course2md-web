//! 原生消息宿主的注册与修复。
//!
//! 安装脚本首次注册；之后 MizoreLink 每次启动都检查注册是否过时（宿主源码更新、配置缺令牌行、
//! Node 换了位置），过时就静默重做——升级代码后不必再手动运行安装命令。
//! Windows 上正在运行的宿主 exe 无法覆盖，所以新 exe 按源码哈希命名，清单改指向新文件，
//! 旧文件等不再被占用时再删。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, ensureHelperToken, tokenPath } from './helper-data.mjs';
import { detectExtensionIds } from './extension-ids.mjs';

export const HOST_NAME = 'com.course2md.helper';
export const DEFAULT_EXTENSION_ID = 'icceajppndlehndkedbflgimdbinmjcf';
const tools = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(tools, 'fast-asr-server.mjs');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** 宿主相关源码的指纹；变了就说明已注册的宿主过时。 */
function hostFingerprint() {
  const digest = createHash('sha256');
  for (const file of ['native-helper.cs', 'native-host.mjs', 'host-registration.mjs']) digest.update(readFileSync(path.join(tools, file)));
  digest.update(`${process.execPath}\n${helper}\n${tokenPath()}`);
  return digest.digest('hex').slice(0, 16);
}

const stampPath = () => path.join(dataDir(), 'host-fingerprint');

/** 各浏览器放宿主清单的位置（Windows 是注册表键，其余是目录）。 */
export function manifestLocations() {
  const home = os.homedir();
  if (isWin) return ['Microsoft\\Edge', 'Google\\Chrome'].map((browser) => `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${HOST_NAME}`);
  const roots = isMac
    ? ['Microsoft Edge', 'Google/Chrome', 'Chromium'].map((name) => path.join(home, 'Library', 'Application Support', ...name.split('/')))
    : ['microsoft-edge', 'google-chrome', 'chromium'].map((name) => path.join(home, '.config', name));
  return roots.map((root) => path.join(root, 'NativeMessagingHosts', `${HOST_NAME}.json`));
}

/**
 * 已注册但过时就返回原因，否则返回空字符串。从没注册过的机器不算过时：
 * 首次注册会写开机自启，应由用户运行安装命令来决定。
 */
export function registrationOutdated() {
  const config = path.join(dataDir(), 'native-helper.config');
  if (!existsSync(config)) return '';
  const lines = readFileSync(config, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  // 只修复指向本份代码的注册；另一份检出正在使用时不去抢
  if (path.resolve(lines[1] ?? '') !== path.resolve(helper)) return '';
  if (lines.length < 4) return '配置缺少访问令牌';
  let stamp = '';
  try { stamp = readFileSync(stampPath(), 'utf8').trim(); } catch { /* 旧版安装没有指纹 */ }
  return stamp === hostFingerprint() ? '' : '宿主程序已更新';
}

/** 读现有清单里允许的扩展，重做注册时保留，避免把手动加过的 ID 丢掉。 */
function currentAllowedOrigins() {
  try {
    return JSON.parse(readFileSync(path.join(dataDir(), 'native-helper.json'), 'utf8')).allowed_origins ?? [];
  } catch {
    return [];
  }
}

/**
 * 注册宿主：写宿主程序、配置（第 4 行是令牌路径）、清单、浏览器注册与开机自启。
 * @param {{extensionIds?: string[]}} options 额外允许的扩展 ID
 * @returns {{host: string, allowedOrigins: string[], detected: string[], token: string}}
 */
export function registerHost({ extensionIds = [] } = {}) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const token = ensureHelperToken(dir);
  const detected = detectExtensionIds();
  const allowedOrigins = [...new Set([
    ...currentAllowedOrigins(),
    ...[...extensionIds, ...detected].map((id) => `chrome-extension://${id}/`),
  ])];
  if (!allowedOrigins.length) allowedOrigins.push(`chrome-extension://${DEFAULT_EXTENSION_ID}/`);
  const fingerprint = hostFingerprint();
  const manifestPath = path.join(dir, 'native-helper.json');
  const eol = isWin ? '\r\n' : '\n';
  writeFileSync(path.join(dir, 'native-helper.config'),
    [process.execPath, helper, 'http://127.0.0.1:8766/health', tokenPath(dir), ''].join(eol));

  let host;
  if (isWin) {
    host = path.join(dir, `native-helper-${fingerprint}.exe`);
    if (!existsSync(host)) {
      const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${host}`, path.join(tools, 'native-helper.cs')], { encoding: 'utf8' });
      if (build.status !== 0) throw new Error(build.stderr || build.stdout || '无法编译本机消息宿主');
    }
  } else {
    // 宿主必须是可执行脚本且行尾为 LF：CRLF 会让 shebang 认不到解释器
    const script = path.join(dir, 'native-host.mjs');
    writeFileSync(script, readFileSync(path.join(tools, 'native-host.mjs'), 'utf8').replaceAll('\r\n', '\n'));
    host = path.join(dir, 'native-host.sh');
    const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    writeFileSync(host, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
    chmodSync(host, 0o755);
  }
  writeFileSync(manifestPath, JSON.stringify({
    name: HOST_NAME, description: 'MizoreLink Standalone launcher', path: host, type: 'stdio', allowed_origins: allowedOrigins,
  }, null, 2));

  for (const location of manifestLocations()) {
    if (isWin) {
      const result = spawnSync('reg.exe', ['add', location, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || '无法注册 MizoreLink');
    } else {
      mkdirSync(path.dirname(location), { recursive: true });
      copyFileSync(manifestPath, location);
    }
  }
  registerAutostart(dir);
  if (isWin) removeStaleHosts(dir, host);
  writeFileSync(stampPath(), fingerprint);
  return { host, allowedOrigins, detected, token };
}

/** 清理清单不再指向的旧宿主 exe（MizoreLink 每次启动时调用）。 */
export function cleanStaleHosts() {
  if (!isWin) return;
  const dir = dataDir();
  let current = '';
  try { current = JSON.parse(readFileSync(path.join(dir, 'native-helper.json'), 'utf8')).path ?? ''; } catch { return; }
  if (current) removeStaleHosts(dir, current);
}

/** 删掉旧版宿主 exe；还在运行的删不掉，下次再清。 */
function removeStaleHosts(dir, current) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (/^native-helper(-[0-9a-f]+)?\.exe$/.test(name) && file !== current) {
      try { unlinkSync(file); } catch { /* 正被浏览器拉起的旧宿主占用 */ }
    }
  }
}

function registerAutostart(dir) {
  const home = os.homedir();
  if (isWin) {
    const launcher = path.join(dir, 'start-helper.vbs');
    const command = `"${process.execPath}" "${helper}"`;
    writeFileSync(launcher, `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`);
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const result = spawnSync('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'course2md-local-asr', '/t', 'REG_SZ', '/d', `"${wscript}" "${launcher}"`, '/f'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || '无法注册开机启动');
  } else if (isMac) {
    const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${HOST_NAME}.plist`);
    mkdirSync(path.dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${HOST_NAME}</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(helper)}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`);
    // 没有 GUI 会话时 launchctl 会失败；.plist 已就位，下次登录自然生效
    spawnSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
  } else {
    const quote = (value) => `"${value.replaceAll('"', '\\"')}"`;
    mkdirSync(path.join(home, '.config', 'autostart'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'autostart', 'course2md-helper.desktop'),
      `[Desktop Entry]\nType=Application\nName=MizoreLink\nExec=${quote(process.execPath)} ${quote(helper)}\nX-GNOME-Autostart-enabled=true\n`);
  }
}

/**
 * Undo everything registerHost() did: browser registrations, autostart and the host files.
 * Returns what was removed so the uninstaller can report it.
 */
export function unregisterHost() {
  const removed = [];
  const home = os.homedir();
  for (const location of manifestLocations()) {
    if (isWin) {
      if (spawnSync('reg.exe', ['delete', location, '/f'], { stdio: 'ignore' }).status === 0) removed.push(location);
    } else if (existsSync(location)) {
      unlinkSync(location);
      removed.push(location);
    }
  }
  if (isWin) {
    const run = spawnSync('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'course2md-local-asr', '/f'], { stdio: 'ignore' });
    if (run.status === 0) removed.push('开机启动项 course2md-local-asr');
  } else if (isMac) {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${HOST_NAME}.plist`);
    if (existsSync(plist)) {
      spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
      unlinkSync(plist);
      removed.push(plist);
    }
  } else {
    const desktop = path.join(home, '.config', 'autostart', 'course2md-helper.desktop');
    if (existsSync(desktop)) {
      unlinkSync(desktop);
      removed.push(desktop);
    }
  }
  const dir = dataDir();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!/^(native-helper.*|native-host\.(mjs|sh)|start-helper\.vbs|helper-token|host-fingerprint)$/.test(name)) continue;
      try {
        unlinkSync(path.join(dir, name));
        removed.push(path.join(dir, name));
      } catch { /* still running; the uninstaller stops services first */ }
    }
  }
  return removed;
}
