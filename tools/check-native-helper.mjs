// Verify the installed native host can launch an HTTP helper from a cold state.
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = join(process.env.LOCALAPPDATA, 'course2md', 'native-helper.exe');
const dir = await mkdtemp(join(tmpdir(), 'c2md-native-'));
const port = await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(() => resolve(number)); });
});
const health = `http://127.0.0.1:${port}/health`;
try {
  await copyFile(source, join(dir, 'native-helper.exe'));
  await writeFile(join(dir, 'fixture.mjs'), `import http from 'node:http';\nconst server=http.createServer((req,res)=>{res.end('ok');if(req.url==='/shutdown')server.close()});server.listen(${port},'127.0.0.1');\n`);
  await writeFile(join(dir, 'native-helper.config'), `${process.execPath}\r\n${join(dir, 'fixture.mjs')}\r\n${health}\r\n`);
  const child = spawn(join(dir, 'native-helper.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
  console.log('本机宿主可自动拉起服务');
  await fetch(`http://127.0.0.1:${port}/shutdown`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
