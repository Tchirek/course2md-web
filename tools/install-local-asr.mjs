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
const nativeLauncher = path.join(dir, 'native-helper.exe');
const nativeManifest = path.join(dir, 'native-helper.json');
const command = `"${process.execPath}" "${helper}"`;
await mkdir(dir, { recursive: true });
await writeFile(launcher, `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`);
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${nativeLauncher}`, path.resolve('tools/native-helper.cs')], { encoding: 'utf8' });
if (build.status !== 0) throw new Error(build.stderr || build.stdout || '无法编译本机消息宿主');
await writeFile(path.join(dir, 'native-helper.config'), `${process.execPath}\r\n${helper}\r\nhttp://127.0.0.1:8766/health\r\n`);
const extensionId = process.argv[2] || 'icceajppndlehndkedbflgimdbinmjcf';
if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('扩展 ID 格式错误');
await writeFile(nativeManifest, JSON.stringify({
  name: 'com.course2md.helper', description: 'course2md local helper launcher',
  path: nativeLauncher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2));
for (const browser of ['Microsoft\\Edge', 'Google\\Chrome']) {
  const result = spawnSync('reg.exe', ['add', `HKCU\\Software\\${browser}\\NativeMessagingHosts\\com.course2md.helper`,
    '/ve', '/t', 'REG_SZ', '/d', nativeManifest, '/f'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || '无法注册本机助手');
}
const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
const registration = spawnSync('reg.exe', [
  'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  '/v', 'course2md-local-asr', '/t', 'REG_SZ', '/d', `"${wscript}" "${launcher}"`, '/f',
], { encoding: 'utf8' });
if (registration.status !== 0) throw new Error(registration.stderr || '无法注册开机启动');

try {
  await fetch('http://127.0.0.1:8766/health', { signal: AbortSignal.timeout(700) });
} catch {
  spawn(process.execPath, [helper], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}
process.stdout.write('本机助手已安装并设置为登录后运行。生成笔记时会自动启动转录模型。\n');
