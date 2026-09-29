// One-time setup for the local helper: registered as a native messaging host, the extension can wake it up; start automatically at login.
// Windows: compiled exe host + registry; macOS/Linux: shebang script host + NativeMessagingHosts directory
// (autostart uses LaunchAgent / XDG autostart respectively). The host behaviors on both sides are consistent (tools/native-host.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const home = process.env.HOME ?? '';

const python = process.env.C2MD_PYTHON || (isWin ? 'python' : 'python3');
let probe = spawnSync(python, ['-c', 'import faster_whisper'], { stdio: 'ignore' });
if (probe.status !== 0) {
  process.stdout.write('正在安装 faster-whisper 运行库…\n');
  probe = spawnSync(python, ['-m', 'pip', 'install', '--user', 'faster-whisper'], { stdio: 'inherit' });
  if (probe.status !== 0) {
    // 新版 Debian/Ubuntu 的系统 Python 受 PEP 668 保护，pip --user 装不进去；这只影响 GPU 转录，不挡助手注册
    if (!isWin) process.stdout.write('faster-whisper 未装上（不影响助手安装）。GPU 转录请手动安装：\n' +
      `  ${python} -m pip install --user --break-system-packages faster-whisper\n`);
    else throw new Error('无法安装 faster-whisper；请先安装 Python 3 和 pip');
  }
}

const helper = path.resolve('tools/fast-asr-server.mjs');
const hostSource = path.resolve('tools/native-host.mjs');
const extensionId = process.argv[2] || 'icceajppndlehndkedbflgimdbinmjcf';
if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('扩展 ID 格式错误');

const dir = isWin ? path.join(process.env.LOCALAPPDATA, 'course2md')
  : isMac ? path.join(home, 'Library', 'Application Support', 'course2md')
  : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'course2md');
mkdirSync(dir, { recursive: true });

if (isWin) {
  const launcher = path.join(dir, 'start-helper.vbs');
  const nativeLauncher = path.join(dir, 'native-helper.exe');
  const nativeManifest = path.join(dir, 'native-helper.json');
  const command = `"${process.execPath}" "${helper}"`;
  writeFileSync(launcher, `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`);
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${nativeLauncher}`, path.resolve('tools/native-helper.cs')], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || '无法编译本机消息宿主');
  writeFileSync(path.join(dir, 'native-helper.config'), `${process.execPath}\r\n${helper}\r\nhttp://127.0.0.1:8766/health\r\n`);
  writeFileSync(nativeManifest, JSON.stringify({
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
} else {
  // 宿主必须是可执行脚本且行尾为 LF：CRLF 会让 shebang 认不到解释器
  const hostPath = path.join(dir, 'native-host.mjs');
  writeFileSync(hostPath, readFileSync(hostSource, 'utf8').replaceAll('\r\n', '\n'));
  chmodSync(hostPath, 0o755);
  writeFileSync(path.join(dir, 'native-helper.config'), `${process.execPath}\n${helper}\nhttp://127.0.0.1:8766/health\n`);
  const manifestPath = path.join(dir, 'native-helper.json');
  writeFileSync(manifestPath, JSON.stringify({
    name: 'com.course2md.helper', description: 'course2md local helper launcher',
    path: hostPath, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2));

  const browserDirs = isMac ? [
    path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'),
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
    path.join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
  ] : [
    path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
    path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
    path.join(home, '.config', 'chromium', 'NativeMessagingHosts'),
  ];
  for (const browserDir of browserDirs) {
    mkdirSync(browserDir, { recursive: true });
    copyFileSync(manifestPath, path.join(browserDir, 'com.course2md.helper.json'));
  }

  if (isMac) {
    const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.course2md.helper.plist');
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.course2md.helper</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(helper)}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`);
    // 没有 GUI 会话时 launchctl 会失败；.plist 已就位，下次登录自然生效
    spawnSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
  } else {
    const quote = (value) => `"${value.replaceAll('"', '\\"')}"`;
    mkdirSync(path.join(home, '.config', 'autostart'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'autostart', 'course2md-helper.desktop'),
      `[Desktop Entry]\nType=Application\nName=course2md local helper\nExec=${quote(process.execPath)} ${quote(helper)}\nX-GNOME-Autostart-enabled=true\n`);
  }
}

try {
  await fetch('http://127.0.0.1:8766/health', { signal: AbortSignal.timeout(700) });
} catch {
  spawn(process.execPath, [helper], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}
process.stdout.write('本机助手已安装并设置为登录后运行。生成笔记时会自动启动转录模型。\n');
if (!isWin && extensionId === 'icceajppndlehndkedbflgimdbinmjcf') {
  process.stdout.write('注意：这里用的是默认扩展 ID。若这台机器上扩展 ID 不同（edge://extensions 开发人员模式页可见），\n请带 ID 重新运行：node tools/install-local-asr.mjs <扩展ID>\n');
}
