//! 原生消息宿主的注册与修复。
//!
//! Python 仅传送 CLI 任务；Node 仅在首次登记浏览器连接时使用。
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
const helper = path.join(tools, 'cli_bridge.py');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** 宿主相关源码的指纹；变了就说明已注册的宿主过时。 */
function hostFingerprint(python) {
  const digest = createHash('sha256');
  for (const file of ['native-helper.cs', 'cli_bridge.py']) digest.update(readFileSync(path.join(tools, file)));
  digest.update(`${python}\n${helper}\n${tokenPath()}`);
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

export function findPython() {
  const command = process.env.C2MD_PYTHON || (isWin ? 'python' : 'python3');
  const result = spawnSync(command, ['-c', 'import sys, tomllib; print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('MizoreLink 需要 Python 3.11 或更新版本，仅使用标准库');
  return result.stdout.trim();
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
 * 注册宿主：写宿主程序、配置（第 4 行是令牌路径）、清单与浏览器注册。
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
  const python = findPython();
  const fingerprint = hostFingerprint(python);
  const manifestPath = path.join(dir, 'native-helper.json');
  const eol = isWin ? '\r\n' : '\n';
  writeFileSync(path.join(dir, 'native-helper.config'),
    [python, helper, 'http://127.0.0.1:8766/health', tokenPath(dir), ''].join(eol));

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
    host = path.join(dir, 'native-host.sh');
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(host, `#!/bin/sh\nexec ${quote(python)} ${quote(helper)} --native-host\n`);
    chmodSync(host, 0o755);
  }
  writeFileSync(manifestPath, JSON.stringify({
    name: HOST_NAME, description: 'MizoreLink CLI launcher', path: host, type: 'stdio', allowed_origins: allowedOrigins,
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
  removeAutostart();
  if (isWin) removeStaleHosts(dir, host);
  writeFileSync(stampPath(), fingerprint);
  return { host, allowedOrigins, detected, token };
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

function removeAutostart() {
  const home = os.homedir();
  if (isWin) {
    spawnSync('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'course2md-local-asr', '/f'], { stdio: 'ignore' });
  } else if (isMac) {
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${HOST_NAME}.plist`);
    if (existsSync(plistPath)) {
      spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
      unlinkSync(plistPath);
    }
  } else {
    const file = path.join(home, '.config', 'autostart', 'course2md-helper.desktop');
    if (existsSync(file)) unlinkSync(file);
  }
}

/**
 * Undo everything registerHost() did: browser registrations, autostart and the host files.
 * Returns what was removed so the uninstaller can report it.
 */
export function unregisterHost() {
  const removed = [];
  for (const location of manifestLocations()) {
    if (isWin) {
      if (spawnSync('reg.exe', ['delete', location, '/f'], { stdio: 'ignore' }).status === 0) removed.push(location);
    } else if (existsSync(location)) {
      unlinkSync(location);
      removed.push(location);
    }
  }
  removeAutostart();
  const dir = dataDir();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!/^(native-helper.*|native-host\.(?:mjs|sh)|start-helper\.vbs|helper-token|host-fingerprint)$/.test(name)) continue;
      try {
        unlinkSync(path.join(dir, name));
        removed.push(path.join(dir, name));
      } catch { /* still running; the uninstaller stops services first */ }
    }
  }
  return removed;
}
