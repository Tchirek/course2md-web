// Windows one-time setup: keep the lightweight local bridge available after login.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('当前安装脚本仅支持 Windows');

const python = process.env.C2MD_PYTHON || 'python';
let probe = spawnSync(python, ['-c', 'import faster_whisper'], { stdio: 'ignore' });
if (probe.status !== 0) {
  process.stdout.write('正在安装 faster-whisper 运行库…\n');
  probe = spawnSync(python, ['-m', 'pip', 'install', '--user', 'faster-whisper'], { stdio: 'inherit' });
  if (probe.status !== 0) throw new Error('无法安装 faster-whisper；请先安装 Python 3 和 pip');
}

const dir = path.join(process.env.LOCALAPPDATA, 'course2md');
const helper = path.resolve('tools/fast-asr-server.mjs');
const launcher = path.join(dir, 'start-helper.vbs');
const command = `"${process.execPath}" "${helper}"`;
await mkdir(dir, { recursive: true });
await writeFile(launcher, `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`);
const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
const registration = spawnSync('reg.exe', [
  'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  '/v', 'course2md-local-asr', '/t', 'REG_SZ', '/d', `"${wscript}" "${launcher}"`, '/f',
], { encoding: 'utf8' });
if (registration.status !== 0) throw new Error(registration.stderr || '无法注册开机启动');

try {
  await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(700) });
} catch {
  spawn(process.execPath, [helper], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}
process.stdout.write('本机助手已安装并设置为登录后运行。现在可在扩展设置页启动转录模型。\n');
