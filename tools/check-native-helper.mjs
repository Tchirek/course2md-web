// Verify the installed native host can launch an HTTP helper from a cold state.
// まずブラウザがホストを探すのと同じ経路で実際の登録を確かめる（レジストリ/マニフェスト →
// ホスト本体 → 許可された拡張 ID → 設定内の Node とヘルパースクリプト）。続いて Windows の
// .exe ホストとクロスプラットフォームの Node ホスト（macOS/Linux で実際に使う方）に同じ
// コールドスタート手順を踏ませる：それぞれ隔離ディレクトリに置き、使い捨ての fixture
// サービスを指させて、ゼロから起動して応答させる。
// 使い方：node tools/check-native-helper.mjs [拡張ID]
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectExtensionIds } from './extension-ids.mjs';
import { dataDir } from './helper-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_NAME = 'com.course2md.helper';
// Check the IDs given on the command line, otherwise every copy loaded in the local browsers.
const extensionIds = process.argv.length > 2 ? process.argv.slice(2) : detectExtensionIds();
if (!extensionIds.length) extensionIds.push('icceajppndlehndkedbflgimdbinmjcf');

let failed = false;
const problems = registrationProblems();
for (const problem of problems) console.error(`注册：${problem}`);
if (problems.length) failed = true;
else console.log(`注册：浏览器能找到宿主，且允许扩展 ${extensionIds.join('、')} 调用`);

const hosts = [];
if (process.platform === 'win32') {
  // exe 按源码哈希命名，以清单里登记的路径为准
  let exe = '';
  try { exe = JSON.parse(readFileSync(join(dataDir(), 'native-helper.json'), 'utf8')).path ?? ''; } catch { /* 未安装 */ }
  if (exe && existsSync(exe)) hosts.push({ label: '.exe 宿主', command: exe, configEol: '\r\n' });
}
hosts.push({ label: 'Node 宿主', command: process.execPath, scriptSource: join(HERE, 'native-host.mjs'), configEol: '\n' });

for (const host of hosts) {
  try { await checkHost(host); } catch (error) {
    failed = true;
    console.error(`${host.label}：${error.message}`);
  }
}
if (failed) console.error('修复：在项目目录运行 npm run local:install（扩展 ID 不是默认值时：node tools/install-local-asr.mjs <扩展ID>）');
process.exit(failed ? 1 : 0);

/** ブラウザごとに参照先が異なる。どこか一箇所が完全なら使えるので、残りの欠落は注意表示に留める。全滅なら各箇所の断点を返す。 */
function registrationProblems() {
  const found = [];
  for (const { where, manifestPath } of manifestLocations()) {
    const issue = manifestPath ? manifestProblem(manifestPath) : '未注册';
    found.push({ where, issue });
  }
  if (found.some(({ issue }) => !issue)) {
    for (const { where, issue } of found) if (issue) console.log(`注册（提示）：${where} ${issue}`);
    return [];
  }
  return found.map(({ where, issue }) => `${where} ${issue}`);
}

function manifestLocations() {
  if (process.platform === 'win32') {
    return ['Microsoft\\Edge', 'Google\\Chrome'].map((browser) => {
      const where = `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${HOST_NAME}`;
      const query = spawnSync('reg.exe', ['query', where, '/ve'], { encoding: 'utf8' });
      const manifestPath = query.status === 0 ? query.stdout.match(/REG_SZ\s+(.+?)\s*$/m)?.[1] ?? null : null;
      return { where, manifestPath };
    });
  }
  const roots = process.platform === 'darwin'
    ? ['Microsoft Edge', 'Google/Chrome', 'Chromium'].map((name) => join(homedir(), 'Library', 'Application Support', name))
    : ['microsoft-edge', 'google-chrome', 'chromium'].map((name) => join(homedir(), '.config', name));
  return roots.map((root) => {
    const where = join(root, 'NativeMessagingHosts', `${HOST_NAME}.json`);
    return { where, manifestPath: existsSync(where) ? where : null };
  });
}

function manifestProblem(manifestPath) {
  if (!existsSync(manifestPath)) return `→ 清单文件不存在：${manifestPath}`;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (error) {
    return `→ 清单无法解析：${manifestPath}（${error.message}）`;
  }
  if (manifest.name !== HOST_NAME) return `→ 清单 name 应为 ${HOST_NAME}`;
  if (!manifest.path || !existsSync(manifest.path)) return `→ 宿主程序不存在：${manifest.path}`;
  const missing = extensionIds.filter((id) => !manifest.allowed_origins?.includes(`chrome-extension://${id}/`));
  if (missing.length) {
    return `→ 未允许扩展 ${missing.join('、')}（只允许 ${manifest.allowed_origins?.join('、') || '无'}）`;
  }
  const configPath = join(dirname(manifest.path), 'native-helper.config');
  if (!existsSync(configPath)) return `→ 宿主配置不存在：${configPath}`;
  const [nodePath, helperPath] = readFileSync(configPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!nodePath || !existsSync(nodePath)) return `→ 配置里的 Node 不存在：${nodePath}`;
  if (!helperPath || !existsSync(helperPath)) return `→ 配置里的助手脚本不存在：${helperPath}`;
  return null;
}

async function checkHost({ label, command, scriptSource = null, configEol }) {
  const dir = await mkdtemp(join(tmpdir(), 'c2md-native-'));
  const port = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(() => resolve(number)); });
  });
  const health = `http://127.0.0.1:${port}/health`;
  try {
    let hostPath;
    if (scriptSource) {
      // Node 宿主经 Git 检出可能是 CRLF，安装器落盘时会归一成 LF；这里按同样规则处理
      hostPath = join(dir, 'native-host.mjs');
      await writeFile(hostPath, (await readFile(scriptSource, 'utf8')).replaceAll('\r\n', '\n'), { mode: 0o755 });
    } else {
      hostPath = join(dir, 'host.exe');
      await copyFile(command, hostPath);
    }
    await writeFile(join(dir, 'fixture.mjs'), `import http from 'node:http';\nconst server=http.createServer((req,res)=>{res.end('ok');if(req.url==='/shutdown')server.close()});server.listen(${port},'127.0.0.1');\n`);
    // 宿主确认启动后要把配置第 4 行指向的访问令牌交出来
    const token = randomBytes(32).toString('hex');
    await writeFile(join(dir, 'helper-token'), token);
    await writeFile(join(dir, 'native-helper.config'), `${process.execPath}${configEol}${join(dir, 'fixture.mjs')}${configEol}${health}${configEol}${join(dir, 'helper-token')}${configEol}`);
    // .exe ホストは自身の置き場所から設定を探すので、隔離ディレクトリ内のコピーを実行しないと実インストールの設定を読んでしまう
    const child = scriptSource
      ? spawn(command, [hostPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(hostPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const body = Buffer.from('{"action":"start"}');
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([size, body]));
    let timeout;
    const reply = await Promise.race([
      new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        child.stdout.on('data', (chunk) => {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) resolve(JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0))));
        });
        child.on('error', reject);
        child.on('exit', (code) => { if (code) reject(new Error(`本机宿主退出：${code}`)); });
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('本机宿主 15 秒未响应')), 15000); }),
    ]);
    clearTimeout(timeout);
    if (!reply.ok) throw new Error(reply.error || '本机宿主未启动服务');
    if (reply.token !== token) throw new Error('本机宿主没有交出访问令牌（宿主是旧版本？重新运行 npm run local:install）');
    console.log(`${label}可自动拉起服务`);
    await fetch(`http://127.0.0.1:${port}/shutdown`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
