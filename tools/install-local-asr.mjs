// One-time setup for the local helper: registered as a native messaging host, the extension can wake it up; start automatically at login.
// Windows: compiled exe host + registry; macOS/Linux: shebang script host + NativeMessagingHosts directory
// (autostart uses LaunchAgent / XDG autostart respectively). The host behaviors on both sides are consistent (tools/native-host.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, ensureHelperToken, tokenPath } from './helper-data.mjs';
import { detectExtensionIds } from './extension-ids.mjs';

// パスはスクリプトの位置から解決する。別ディレクトリから実行しても、ホスト設定には正しいヘルパーのパスが書かれる
const tools = path.dirname(fileURLToPath(import.meta.url));

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const home = process.env.HOME ?? '';

const python = process.env.C2MD_PYTHON || (isWin ? 'python' : 'python3');
let probe = spawnSync(python, ['-c', 'import faster_whisper'], { stdio: 'ignore' });
if (probe.status !== 0) {
  process.stdout.write('正在安装 faster-whisper 运行库…\n');
  probe = spawnSync(python, ['-m', 'pip', 'install', '--user', 'faster-whisper'], { stdio: 'inherit' });
  if (probe.status !== 0) {
    // 影響するのはローカル文字起こしだけで、ヘルパー登録は止めない。ホストがなければフレーム取得や音声ダウンロードでもヘルパーを起こせない
    // （新しい Debian/Ubuntu のシステム Python は PEP 668 で保護され、pip --user では入らない）
    process.stdout.write('faster-whisper 未装上（不影响助手安装）。本机转录请先装好 Python 3 和 pip，再手动安装：\n' +
      `  ${python} -m pip install --user ${isWin ? '' : '--break-system-packages '}faster-whisper\n`);
  }
}

const helper = path.join(tools, 'fast-asr-server.mjs');
const hostSource = path.join(tools, 'native-host.mjs');
// Allow every loaded copy of the extension (IDs of unpacked extensions depend on their folder),
// plus any IDs given on the command line. The fixed default is only a fallback for installing
// before the extension has been loaded.
const requested = process.argv.slice(2);
for (const id of requested) if (!/^[a-p]{32}$/.test(id)) throw new Error(`扩展 ID 格式错误：${id}`);
const detected = detectExtensionIds();
const extensionIds = [...new Set([...requested, ...detected])];
if (!extensionIds.length) extensionIds.push('icceajppndlehndkedbflgimdbinmjcf');
const allowedOrigins = extensionIds.map((id) => `chrome-extension://${id}/`);

const dir = dataDir();
mkdirSync(dir, { recursive: true });
// 助手的访问令牌：宿主确认助手已启动后，把它放进应答交给扩展（配置第 4 行是它的路径）
const token = ensureHelperToken(dir);

let host;
if (isWin) {
  const launcher = path.join(dir, 'start-helper.vbs');
  const nativeLauncher = path.join(dir, 'native-helper.exe');
  const nativeManifest = path.join(dir, 'native-helper.json');
  host = nativeLauncher;
  const command = `"${process.execPath}" "${helper}"`;
  writeFileSync(launcher, `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`);
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${nativeLauncher}`, path.join(tools, 'native-helper.cs')], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || '无法编译本机消息宿主');
  writeFileSync(path.join(dir, 'native-helper.config'), `${process.execPath}\r\n${helper}\r\nhttp://127.0.0.1:8766/health\r\n${tokenPath(dir)}\r\n`);
  writeFileSync(nativeManifest, JSON.stringify({
    name: 'com.course2md.helper', description: 'course2md local helper launcher',
    path: nativeLauncher, type: 'stdio', allowed_origins: allowedOrigins,
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
  host = hostPath;
  writeFileSync(hostPath, readFileSync(hostSource, 'utf8').replaceAll('\r\n', '\n'));
  chmodSync(hostPath, 0o755);
  writeFileSync(path.join(dir, 'native-helper.config'), `${process.execPath}\n${helper}\nhttp://127.0.0.1:8766/health\n${tokenPath(dir)}\n`);
  const manifestPath = path.join(dir, 'native-helper.json');
  writeFileSync(manifestPath, JSON.stringify({
    name: 'com.course2md.helper', description: 'course2md local helper launcher',
    path: hostPath, type: 'stdio', allowed_origins: allowedOrigins,
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

// ヘルパーを直接起動せず、ブラウザと同じく登録したてのホスト経由で起こす。ホストの不具合は
// 再起動後に拡張が起こせなくなって初めて気づくのではなく、今ここで報告される
const reply = await wakeThroughHost(host);
if (!reply.ok) throw new Error(`本机宿主已注册，但未能拉起助手：${reply.error}`);
if (reply.token !== token) throw new Error('本机宿主没有交出正确的访问令牌；扩展将无法使用本机助手');
process.stdout.write('本机助手已安装并设置为登录后运行。生成笔记时会自动启动转录模型。\n');
if (detected.length) {
  process.stdout.write(`已允许浏览器里加载的这些扩展调用本机助手：${extensionIds.join('、')}\n`);
} else {
  process.stdout.write('没有在 Edge / Chrome 里找到已加载的 course2md，暂按默认扩展 ID 注册。\n' +
    '先在浏览器加载扩展再重新运行本命令即可自动识别；也可以直接带上 ID：node tools/install-local-asr.mjs <扩展ID>\n');
}

/** ネイティブメッセージングの形式（4 バイトのリトルエンディアン長 + JSON）でホストに start を送り、応答を読み取る。 */
function wakeThroughHost(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('本机宿主 15 秒未应答')); }, 15000);
    let bytes = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4 || bytes.length < 4 + bytes.readUInt32LE(0)) return;
      clearTimeout(timer);
      resolve(JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0))));
    });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`无法运行本机宿主 ${command}：${error.message}`)); });
    // exit ではなく close を使う：exit は stdout に残った応答を読み切る前に来ることがある
    child.on('close', (code) => {
      if (bytes.length < 4) { clearTimeout(timer); reject(new Error(`本机宿主未应答就退出（代码 ${code}）`)); }
    });
    const body = Buffer.from('{"action":"start"}');
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([size, body]));
  });
}
