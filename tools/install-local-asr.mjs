// One-time browser registration. Runtime processing belongs to course2md CLI.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chooseDataDir, dataDir } from './helper-data.mjs';
import { stopServices } from './services.mjs';

const args = process.argv.slice(2);
const flag = args.indexOf('--data-dir');
if (flag >= 0) {
  if (!args[flag + 1]) throw new Error('--data-dir 后面要跟一个目录');
  await stopServices();
  chooseDataDir(args.splice(flag, 2)[1]);
}
for (const id of args) if (!/^[a-p]{32}$/.test(id)) throw new Error(`扩展 ID 格式错误：${id}`);
await stopServices();
const source = path.dirname(fileURLToPath(import.meta.url));
const installed = path.join(dataDir(), 'helper', 'tools');
mkdirSync(installed, { recursive: true });
for (const name of ['cli_bridge.py', 'desktop_sync.py', 'native-helper.cs', 'host-registration.mjs', 'helper-data.mjs', 'extension-ids.mjs']) {
  if (path.resolve(source) !== path.resolve(installed)) copyFileSync(path.join(source, name), path.join(installed, name));
}
const { registerHost } = await import(pathToFileURL(path.join(installed, 'host-registration.mjs')).href);
const { host, token, allowedOrigins } = registerHost({ extensionIds: args });
const child = spawn(host, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
const body = Buffer.from('{"action":"start"}');
const size = Buffer.alloc(4);
size.writeUInt32LE(body.length);
child.stdin.end(Buffer.concat([size, body]));
let bytes = Buffer.alloc(0);
const timer = setTimeout(() => child.kill(), 15000);
child.stdout.on('data', (chunk) => { bytes = Buffer.concat([bytes, chunk]); });
await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
clearTimeout(timer);
if (bytes.length < 4 || bytes.length !== 4 + bytes.readUInt32LE(0)) throw new Error('浏览器连接宿主没有完整应答');
const reply = JSON.parse(bytes.subarray(4));
if (!reply.ok || reply.token !== token) throw new Error(reply.error || '连接令牌不匹配');
console.log(`CLI 浏览器连接已登记：${allowedOrigins.join('、')}`);
console.log('转录、截图、模型准备与润色使用 course2md CLI；无需登录自启或单独模型服务。');
