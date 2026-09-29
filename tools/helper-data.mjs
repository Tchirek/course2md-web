//! 本机助手的数据目录（原生宿主及其配置、访问令牌）与令牌的读写。
//! 安装脚本、助手、检查脚本都从这里取路径，保证指向同一处。

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_FILE = 'helper-token';

/** 数据目录。可用 C2MD_DATA_DIR 覆盖（测试用）。 */
export function dataDir() {
  if (process.env.C2MD_DATA_DIR) return process.env.C2MD_DATA_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'course2md');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'course2md');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'course2md');
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
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`本机助手的访问令牌文件已损坏：${tokenPath(dir)}`);
  return token;
}
