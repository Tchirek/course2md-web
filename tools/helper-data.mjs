//! 本机助手的数据目录（原生宿主及其配置、访问令牌）与令牌的读写。
//! 安装脚本、助手、检查脚本都从这里取路径，保证指向同一处。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_FILE = 'helper-token';
/**
 * This project's own runtimes and polish models, removed by `local:uninstall -- --purge`. The speech model
 * is not among them: it lives in the folder shared with the original course2md (see qwen-asr.py).
 */
export const DATA_PARTS = ['asr', 'polish'];
/** Written in the default directory when the user picks another one (npm run local:install -- --data-dir). */
export const LOCATION_FILE = 'location.json';

/** The platform's default data directory. Always the same, so the choice below can be found from anywhere. */
export function defaultDataDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'course2md');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'course2md');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'course2md');
}

/**
 * 数据目录（助手、原生宿主、模型与运行库都在这里）。C2MD_DATA_DIR 优先（测试用）。
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

/**
 * Where the speech model goes when the original course2md has no say yet: a data directory moved off
 * its default place (--data-dir) usually means the system drive is short of space, so the shared model
 * should live there too. Null when the data directory is in its default place.
 */
export function sharedModelTarget() {
  // C2MD_DATA_DIR is for tests: never point the original's config.toml at a scratch folder
  if (process.env.C2MD_DATA_DIR) return null;
  return path.resolve(dataDir()) === path.resolve(defaultDataDir()) ? null : path.join(dataDir(), 'models');
}

/**
 * The faster-whisper transcription that the shared Qwen3-ASR replaced: its environment (with the CUDA
 * libraries) and its model, about 2.5 GB that nothing uses any more. Only those exact paths; the
 * models folder itself may be the one shared with the original course2md.
 * @param {(removed: string) => void} [onRemoved]
 */
export function removeObsoleteWhisper(onRemoved = () => {}) {
  const whisper = 'models--Systran--faster-whisper-small';
  const targets = [];
  // with C2MD_DATA_DIR (tests) only that directory is touched
  const isolated = Boolean(process.env.C2MD_DATA_DIR);
  for (const base of new Set(isolated ? [dataDir()] : [dataDir(), defaultDataDir()])) {
    targets.push(...['venv', 'downloads', 'tmp', 'constraints.txt', '.install.lock'].map((name) => path.join(base, 'asr', name)));
    targets.push(path.join(base, 'models', whisper), path.join(base, 'models', '.locks', whisper), path.join(base, 'models', 'verified.json'));
  }
  // older versions kept the model under ~/.cache on macOS / Linux (now also where the original keeps its models)
  if (process.platform !== 'win32' && !isolated) {
    const legacy = path.join(os.homedir(), '.cache', 'course2md', 'models');
    targets.push(path.join(legacy, whisper), path.join(legacy, '.locks', whisper));
  }
  for (const target of targets.filter((item) => existsSync(item))) {
    rmSync(target, { recursive: true, force: true });
    onRemoved(target);
  }
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
