//! MizoreLink 的数据目录（原生宿主及其配置、访问令牌）与令牌的读写。
//! 安装脚本、MizoreLink、检查脚本都从这里取路径，保证指向同一处。

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_FILE = 'helper-token';
/** Transport data only. Shared models, CLI configuration and course libraries are never purged. */
export const DATA_PARTS = ['helper', 'bridge-jobs'];
/** Written in the default directory when the user picks another one (npm run local:install -- --data-dir). */
export const LOCATION_FILE = 'location.json';

/** The platform's default data directory. Always the same, so the choice below can be found from anywhere. */
export function defaultDataDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'course2md');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'course2md');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'course2md');
}

/**
 * 浏览器连接数据目录。C2MD_DATA_DIR 优先（测试用）。
 * The location is decided once, at install time, and recorded; it never follows free disk space
 * at the moment of use. (It used to switch drives when one ran low, silently landing on a second,
 * half-installed environment.)
 */
export function dataDir() {
  if (process.env.C2MD_DATA_DIR) return process.env.C2MD_DATA_DIR;
  const base = defaultDataDir();
  try {
    const chosen = JSON.parse(readFileSync(path.join(base, LOCATION_FILE), 'utf8')).dir;
    if (typeof chosen === 'string' && path.isAbsolute(chosen)) return chosen;
  } catch { /* no choice recorded: use the default */ }
  return base;
}

/** Records the chosen data directory (or forgets the choice when it is the default). */
export function chooseDataDir(dir) {
  const base = defaultDataDir();
  const target = path.resolve(dir);
  mkdirSync(base, { recursive: true });
  if (target === path.resolve(base)) rmSync(path.join(base, LOCATION_FILE), { force: true });
  else writeFileSync(path.join(base, LOCATION_FILE), `${JSON.stringify({ dir: target }, null, 2)}
`);
  mkdirSync(target, { recursive: true });
  return target;
}

export function tokenPath(dir = dataDir()) {
  return path.join(dir, TOKEN_FILE);
}

/**
 * 返回访问令牌，没有就生成。用独占创建（wx），多个进程同时生成也只会留下一份。
 * 以 0600 创建，只有本人能读（Windows 上 %LOCALAPPDATA% 本来就只归本人）。
 */
export function ensureHelperToken(dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(tokenPath(dir), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readHelperToken(dir);
}

export function readHelperToken(dir = dataDir()) {
  const token = readFileSync(tokenPath(dir), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`MizoreLink 的访问令牌文件已损坏：${tokenPath(dir)}`);
  return token;
}
