// 只在用户启用本机润色时准备隔离的 Python 环境。
// 策略：优先复用系统 Python 已装的 torch（FireRedPunc 走 CPU，不需要 CUDA 版）；
// 缺什么装什么，不再无条件拉 7GB 的 CUDA 轮子。模型与运行库放在数据目录下（安装时选定，见 helper-data.mjs）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './helper-data.mjs';

process.env.PIP_DISABLE_PIP_VERSION_CHECK = '1';

function freeGB(dir) {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize / 1e9;
  } catch {
    return 0;
  }
}

/**
 * The polish environment and its models live in one fixed place under the data directory.
 * It must not depend on free space at launch time: it used to jump to another drive when this one ran
 * low, landing on a second environment that was never fully installed.
 */
function polishHome() {
  return process.env.C2MD_POLISH_HOME || path.join(dataDir(), 'polish');
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
  ['import transformers, tokenizers, sentencepiece; assert transformers.__version__ == "4.51.3"; assert tokenizers.__version__.startswith("0.21.")', 'transformers', ['--force-reinstall', '--no-deps', 'transformers==4.51.3', 'tokenizers==0.21.4', 'sentencepiece']],
]) {
  const check = spawnSync(python, ['-c', probe], { stdio: 'ignore' });
  if (check.status === 0) continue;
  const drive = path.parse(root).root;
  const free = freeGB(drive);
  if (free < 1.5) {
    say('error', `磁盘剩余空间不足（${drive} 还剩 ${Math.round(free * 10) / 10} GB）。请清理磁盘，或把数据目录移到空闲的盘：npm run local:install -- --data-dir <目录>`);
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
