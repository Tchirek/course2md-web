// One-time setup for the local helper: registered as a native messaging host, the extension can wake it up; start automatically at login.
// Windows: compiled exe host + registry; macOS/Linux: shebang script host + NativeMessagingHosts directory
// (autostart uses LaunchAgent / XDG autostart respectively). The host behaviors on both sides are consistent (tools/native-host.mjs).
//
// npm run local:install                          install (or repair) in the current data directory
// npm run local:install -- --data-dir D:\course2md   move the data directory (models, runtimes, host) there first
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { LOCATION_FILE, chooseDataDir, dataDir, removeObsoleteWhisper, sharedModelTarget, pythonCommand } from './helper-data.mjs';
import { registerHost } from './host-registration.mjs';
import { stopServices } from './services.mjs';

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

// Local transcription runs the original course2md's Qwen3-ASR model on llama.cpp, from a Python that needs
// only its standard library (qwen-asr.py). Nothing to install here: the model is found, or fetched, on first
// use. Failing here only affects local transcription: the helper is still installed
const python = pythonCommand();
const qwen = fileURLToPath(new URL('./qwen-asr.py', import.meta.url));
const pythonEnv = { ...process.env, C2MD_DATA_DIR: dataDir() };
const check = spawnSync(python, ['-c', 'import sys, tomllib; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', windowsHide: true });
if (check.status !== 0) {
  process.stdout.write('本机转录需要 Python 3.11 或更新版本（只用标准库）；装好后无须重跑本命令。本机助手照常安装。\n');
} else {
  // A data directory on another drive usually means the system drive is short of space. Unless the original
  // already has its own choice or its own copy of the model, both programs then keep the model there
  const target = sharedModelTarget();
  const shared = spawnSync(python, [qwen, ...(target ? ['--configure-models', target] : ['--model-dir'])],
    { encoding: 'utf8', windowsHide: true, env: pythonEnv });
  if (shared.status !== 0) process.stdout.write(`没能确定与 course2md 共用的模型目录（本机助手照常安装）：${(shared.stdout || shared.stderr).trim()}\n`);
  else process.stdout.write(`本机转录与 course2md 共用模型目录：${shared.stdout.trim()}\n`);
}
removeObsoleteWhisper((target) => process.stdout.write(`已删除不再使用的 faster-whisper 转录环境与模型：${target}\n`));
// 注册逻辑在 host-registration.mjs：本机助手启动时也用它自动修复过时的注册
const { host, allowedOrigins, detected, token } = registerHost({ extensionIds: requested });
stopServices();

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
    // Shared weights remain at the path recorded by upstream, even when helper data moves.
    if (name === LOCATION_FILE || name === 'models') continue;
    if (!/^(asr|polish|bin|runtime\.json|native-helper.*|native-host\.(mjs|sh)|start-helper\.vbs|helper-token|host-fingerprint)$/.test(name)) continue;
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
