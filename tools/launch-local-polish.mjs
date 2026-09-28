// 只在用户启用本机润色时准备隔离的 Python 环境。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.join(process.env.LOCALAPPDATA || os.homedir(), 'course2md', 'polish');
const venv = path.join(root, 'venv');
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
mkdirSync(root, { recursive: true });
if (!existsSync(python)) {
  process.stdout.write(JSON.stringify({ state: 'installing', message: '正在准备本机润色环境' }) + '\n');
  const result = spawnSync(process.env.C2MD_PYTHON || 'python', ['-m', 'venv', '--system-site-packages', venv], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const torchCheck = spawnSync(python, ['-c', 'import torch; assert tuple(map(int, torch.__version__.split("+")[0].split(".")[:2])) >= (2, 6)'], { stdio: 'ignore' });
if (torchCheck.status !== 0) {
  process.stdout.write(JSON.stringify({ state: 'installing', message: '正在更新本机显卡运行库' }) + '\n');
  const install = spawnSync(python, ['-m', 'pip', 'install', 'torch==2.6.0', 'torchvision==0.21.0', '--index-url', 'https://download.pytorch.org/whl/cu124'], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status || 1);
}
const check = spawnSync(python, ['-c', 'import transformers'], { stdio: 'ignore' });
if (check.status !== 0) {
  process.stdout.write(JSON.stringify({ state: 'installing', message: '正在安装本机润色运行库' }) + '\n');
  const install = spawnSync(python, ['-m', 'pip', 'install', 'transformers==4.51.3'], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status || 1);
}
const script = fileURLToPath(new URL('./local-polish.py', import.meta.url));
const child = spawn(python, ['-u', script], {
  env: { ...process.env, C2MD_POLISH_HOME: root, PYTHONIOENCODING: 'utf-8',
    PATH: `${path.dirname(python)}${path.delimiter}${process.env.PATH || ''}` },
  windowsHide: true, stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code || 0));
