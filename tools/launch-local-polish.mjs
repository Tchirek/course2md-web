// 只在用户启用本机润色时准备隔离的 Python 环境。
// 策略：优先复用系统 Python 已装的 torch（FireRedPunc 走 CPU，不需要 CUDA 版），不再无条件拉 7GB 的 CUDA 轮子；
// 其余依赖按固定版本装进本环境。模型与运行库放在数据目录下（安装时选定，见 helper-data.mjs）。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './helper-data.mjs';
import { withLock } from './install-lock.mjs';
import { pipInstall } from './pip-install.mjs';

const PINS = JSON.parse(readFileSync(new URL('./runtime-pins.json', import.meta.url), 'utf8'))['polish-python'];

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

// One launcher prepares the environment at a time: two pip runs in the same venv reinstall packages
// under each other, and the one that finishes first imports a half-written package
try {
  await withLock(path.join(root, '.install.lock'), prepareEnvironment,
    { onWait: () => say('installing', '另一个安装正在进行，等待其完成') });
} catch (error) {
  say('error', String(error?.message ?? error));
  process.exit(1);
}

/**
 * Installs the pinned packages (runtime-pins.json → polish-python) into the venv once, then records it.
 * Later launches only compare that record, instead of probing imports and force-reinstalling.
 */
async function prepareEnvironment() {
  const stamp = path.join(venv, 'c2md-polish.json');
  const expected = createHash('sha256').update(JSON.stringify(PINS)).digest('hex');
  if (existsSync(python)) {
    try {
      if (JSON.parse(readFileSync(stamp, 'utf8')).stamp === expected) return;
    } catch { /* not recorded yet: install */ }
  }
  const drive = path.parse(path.resolve(root)).root;
  const free = freeGB(drive);
  if (free < 1.5) {
    throw new Error(`磁盘剩余空间不足（${drive} 还剩 ${Math.round(free * 10) / 10} GB）。请清理磁盘，或把数据目录移到空闲的盘：npm run local:install -- --data-dir <目录>`);
  }
  // pip's downloads go to TEMP first: keep them on the data drive too
  const tmp = path.join(root, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, PYTHONIOENCODING: 'utf-8' };
  const pip = async (args, what) => {
    const result = await pipInstall(python, args, {
      env,
      onLine: (line) => process.stdout.write(`${line}\n`),
      onRetry: () => say('installing', `下载出错，正在重试本机润色运行库的安装（${what}）`),
    });
    if (result.code !== 0) throw new Error(`安装本机润色运行库失败（${what}）：${result.tail.trim().split('\n').pop()}`);
  };
  try {
    if (!existsSync(python)) {
      say('installing', '正在准备本机润色环境');
      const created = spawnSync(process.env.C2MD_PYTHON || 'python', ['-m', 'venv', '--system-site-packages', venv], { stdio: ['ignore', 'inherit', 'inherit'], env });
      if (created.status !== 0) throw new Error('无法创建本机润色环境');
    }
    // PyTorch is large: reuse the system's if it has one (FireRedPunc only needs the CPU)
    if (spawnSync(python, ['-c', 'import torch'], { stdio: 'pipe', env }).status !== 0) {
      say('installing', '正在安装本机润色运行库（torch）');
      await pip([`torch==${PINS.torch}`], 'torch');
    }
    // Everything else goes into the venv at the pinned versions, with its dependencies, even when the
    // system has other versions: --ignore-installed keeps the system's packages from standing in for them
    say('installing', '正在安装本机润色运行库（版本已固定）');
    const constraints = path.join(root, 'constraints.txt');
    writeFileSync(constraints, Object.entries(PINS.packages).map(([name, version]) => `${name}==${version}`).join('\n') + '\n');
    await pip(['--ignore-installed', '-c', constraints, ...Object.entries(PINS.packages).map(([name, version]) => `${name}==${version}`)], 'transformers');
    const check = spawnSync(python, ['-c', 'import torch, transformers, tokenizers, sentencepiece; print(transformers.__version__)'], { encoding: 'utf8', env });
    if (check.status !== 0 || !check.stdout.includes(PINS.packages.transformers)) {
      throw new Error(`本机润色环境安装后自检失败：${String(check.stderr).trim().split('\n').pop()}`);
    }
    writeFileSync(stamp, JSON.stringify({ stamp: expected, at: new Date().toISOString() }, null, 2));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const script = fileURLToPath(new URL('./local-polish.py', import.meta.url));
const child = spawn(python, ['-u', script], {
  env: { ...process.env, C2MD_POLISH_HOME: root, PYTHONIOENCODING: 'utf-8',
    PATH: `${path.dirname(python)}${path.delimiter}${process.env.PATH || ''}` },
  windowsHide: true, stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code || 0));
