// 只在用户启用本机润色时准备隔离的 Python 环境。
// 策略：优先复用系统 Python 已装的 torch（FireRedPunc 走 CPU，不需要 CUDA 版）；
// 缺什么装什么，不再无条件拉 7GB 的 CUDA 轮子；模型与运行库放到空闲的盘上。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statfsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function freeGB(dir) {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize / 1e9;
  } catch {
    return 0;
  }
}

/** 模型与运行库（Qwen GGUF、llama.cpp）体积大，默认放在空闲盘上。 */
function polishHome() {
  if (process.env.C2MD_POLISH_HOME) return process.env.C2MD_POLISH_HOME;
  const local = path.join(process.env.LOCALAPPDATA || os.homedir(), 'course2md', 'polish');
  const localDrive = path.parse(local).root;
  if (process.platform === 'win32' && existsSync('Q:\\') && freeGB(localDrive) < 6 && freeGB('Q:\\') > 6) {
    return 'Q:\\c2md-data\\polish';
  }
  return local;
}

const root = polishHome();
const venv = path.join(root, 'venv');
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
mkdirSync(root, { recursive: true });

function say(state, message) {
  process.stdout.write(`${JSON.stringify({ state, message })}\n`);
}

if (!existsSync(python)) {
  say('installing', '正在准备本机润色环境');
  const result = spawnSync(process.env.C2MD_PYTHON || 'python', ['-m', 'venv', '--system-site-packages', venv], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

// 逐项探测，缺了才装；pip 不再写缓存目录。
for (const [probe, name, packages] of [
  ['import torch', 'torch', ['torch==2.6.0']],
  ['import transformers, sentencepiece', 'transformers', ['transformers==4.51.3', 'sentencepiece']],
]) {
  const check = spawnSync(python, ['-c', probe], { stdio: 'ignore' });
  if (check.status === 0) continue;
  const drive = path.parse(root).root;
  const free = freeGB(drive);
  if (free < 1.5) {
    say('error', `磁盘剩余空间不足（${drive} 还剩 ${Math.round(free * 10) / 10} GB）。请清理磁盘，或设置 C2MD_POLISH_HOME 指向空闲的盘。`);
    process.exit(1);
  }
  say('installing', `正在安装本机润色运行库（${name}）`);
  const install = spawnSync(python, ['-m', 'pip', 'install', '--no-cache-dir', ...packages], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status || 1);
}

const script = fileURLToPath(new URL('./local-polish.py', import.meta.url));
const child = spawn(python, ['-u', script], {
  env: { ...process.env, C2MD_POLISH_HOME: root, PYTHONIOENCODING: 'utf-8',
    PATH: `${path.dirname(python)}${path.delimiter}${process.env.PATH || ''}` },
  windowsHide: true, stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code || 0));
