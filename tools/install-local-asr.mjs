// One-time setup for the local helper: registered as a native messaging host, the extension can wake it up; start automatically at login.
// Windows: compiled exe host + registry; macOS/Linux: shebang script host + NativeMessagingHosts directory
// (autostart uses LaunchAgent / XDG autostart respectively). The host behaviors on both sides are consistent (tools/native-host.mjs).
//
// npm run local:install                          install (or repair) in the current data directory
// npm run local:install -- --data-dir D:\course2md   move the data directory (models, runtimes, host) there first
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCATION_FILE, chooseDataDir, dataDir } from './helper-data.mjs';
import { registerHost } from './host-registration.mjs';
import { stopServices } from './services.mjs';

// パスはスクリプトの位置から解決する。別ディレクトリから実行しても、ホスト設定には正しいヘルパーのパスが書かれる
const tools = path.dirname(fileURLToPath(import.meta.url));

const isWin = process.platform === 'win32';

const python = process.env.C2MD_PYTHON || (isWin ? 'python' : 'python3');
// 版本固定在 runtime-pins.json：任何时候安装都是同一个版本。已装的其他版本不动（那是用户自己的环境）
const fasterWhisper = JSON.parse(readFileSync(path.join(tools, 'runtime-pins.json'), 'utf8'))['faster-whisper'].pip;
let probe = spawnSync(python, ['-c', 'import faster_whisper'], { stdio: 'ignore' });
if (probe.status !== 0) {
  process.stdout.write(`正在安装 ${fasterWhisper} 运行库…\n`);
  probe = spawnSync(python, ['-m', 'pip', 'install', '--user', fasterWhisper], { stdio: 'inherit' });
  if (probe.status !== 0) {
    // 影響するのはローカル文字起こしだけで、ヘルパー登録は止めない。ホストがなければフレーム取得や音声ダウンロードでもヘルパーを起こせない
    // （新しい Debian/Ubuntu のシステム Python は PEP 668 で保護され、pip --user では入らない）
    process.stdout.write('faster-whisper 未装上（不影响助手安装）。本机转录请先装好 Python 3 和 pip，再手动安装：\n' +
      `  ${python} -m pip install --user ${isWin ? '' : '--break-system-packages '}${fasterWhisper}\n`);
  }
}

const args = process.argv.slice(2);
const flag = args.findIndex((arg) => arg === '--data-dir' || arg.startsWith('--data-dir='));
let targetDir = null;
if (flag >= 0) {
  targetDir = args[flag].includes('=') ? args[flag].slice('--data-dir='.length) : args[flag + 1];
  if (!targetDir) throw new Error('--data-dir 后面要跟一个目录');
  args.splice(flag, args[flag].includes('=') ? 1 : 2);
}
const requested = args;
for (const id of requested) if (!/^[a-p]{32}$/.test(id)) throw new Error(`扩展 ID 格式错误：${id}`);
if (targetDir) moveDataDir(path.resolve(targetDir));
// 注册逻辑在 host-registration.mjs：本机助手启动时也用它自动修复过时的注册
const { host, allowedOrigins, detected, token } = registerHost({ extensionIds: requested });

// ヘルパーを直接起動せず、ブラウザと同じく登録したてのホスト経由で起こす。ホストの不具合は
// 再起動後に拡張が起こせなくなって初めて気づくのではなく、今ここで報告される
const reply = await wakeThroughHost(host);
if (!reply.ok) throw new Error(`本机宿主已注册，但未能拉起助手：${reply.error}`);
if (reply.token !== token) throw new Error('本机宿主没有交出正确的访问令牌；扩展将无法使用本机助手');
process.stdout.write('本机助手已安装并设置为登录后运行。生成笔记时会自动启动转录模型。\n');
if (detected.length) {
  process.stdout.write(`已允许这些扩展调用本机助手：${allowedOrigins.map((origin) => origin.slice('chrome-extension://'.length, -1)).join('、')}\n`);
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

/**
 * Moves everything in the current data directory (models, runtimes, host, token) to target and
 * records target as the data directory. The services are stopped first: they hold files open there.
 * The token moves along, so the extension keeps working without being told a new one.
 */
function moveDataDir(target) {
  const from = path.resolve(dataDir());
  if (from === target) return;
  if (target.startsWith(from + path.sep)) throw new Error('新的数据目录不能放在原数据目录里面');
  stopServices();
  mkdirSync(target, { recursive: true });
  const skipped = [];
  for (const name of existsSync(from) ? readdirSync(from) : []) {
    if (name === LOCATION_FILE) continue;
    const source = path.join(from, name);
    const destination = path.join(target, name);
    if (existsSync(destination)) {
      skipped.push(name);
      continue;
    }
    process.stdout.write(`正在移动 ${name}…
`);
    try {
      renameSync(source, destination);
    } catch (error) {
      if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
      // another drive: copy, then delete the original
      cpSync(source, destination, { recursive: true });
      rmSync(source, { recursive: true, force: true });
    }
  }
  chooseDataDir(target);
  process.stdout.write(`数据目录已改为 ${target}
`);
  if (skipped.length) process.stdout.write(`新目录里已有同名内容，保留原处未移动：${skipped.join('、')}（位于 ${from}）
`);
}
