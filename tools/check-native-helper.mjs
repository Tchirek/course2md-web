// Verify the installed native host can launch an HTTP helper from a cold state.
// Windows 的 .exe 宿主和跨平台的 Node 宿主（macOS/Linux 实际使用的那个）跑同一套
// 冷启动流程：各自放进隔离目录、指向一个一次性 fixture 服务，从零拉起再应答。
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const hosts = [];
if (process.platform === 'win32') {
  const exe = join(process.env.LOCALAPPDATA, 'course2md', 'native-helper.exe');
  if (existsSync(exe)) hosts.push({ label: '.exe 宿主', command: exe, configEol: '\r\n' });
  else console.log('.exe 宿主未安装（运行 npm run local:install 后可查）；跳过');
}
hosts.push({ label: 'Node 宿主', command: process.execPath, scriptSource: join(HERE, 'native-host.mjs'), configEol: '\n' });

let failed = false;
for (const host of hosts) {
  try { await checkHost(host); } catch (error) {
    failed = true;
    console.error(`${host.label}：${error.message}`);
  }
}
process.exit(failed ? 1 : 0);

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
    await writeFile(join(dir, 'native-helper.config'), `${process.execPath}${configEol}${join(dir, 'fixture.mjs')}${configEol}${health}${configEol}`);
    const child = spawn(command, scriptSource ? [hostPath] : [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    console.log(`${label}可自动拉起服务`);
    await fetch(`http://127.0.0.1:${port}/shutdown`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
