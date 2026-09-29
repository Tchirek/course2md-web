#!/usr/bin/env node
//! 本机消息宿主（跨平台）：收到扩展的 start 消息就把本机助手拉起来。
//!
//! Windows 上用的是 native-helper.cs 编译出的 exe（.cmd/.bat 会被浏览器拒绝）；
//! macOS/Linux 允许带 shebang 的脚本直接作宿主，所以这一个 Node 脚本在两类
//! 系统上行为一致。两者读同一份 `native-helper.config`（自己目录下的三行：
//! node 路径、助手脚本路径、健康检查 URL），协议也一致：4 字节小端长度 + JSON。
//!
//! 配置第 4 行是助手访问令牌的文件路径。确认助手已启动后把令牌放进应答；这条通道
//! 只对 allowed_origins 里的扩展开放，所以令牌只会交给本扩展。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// stdin 缓存要跨读取保留：长度和正文常在同一个 data 事件里到达，
// 第一次只取 4 字节时，剩下的必须留给下一次读。
let pending = Buffer.alloc(0);
let stdinEof = false;
let pendingWake = null;
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  const wake = pendingWake;
  pendingWake = null;
  wake?.();
});
process.stdin.once('end', () => {
  stdinEof = true;
  const wake = pendingWake;
  pendingWake = null;
  wake?.();
});
process.stdin.once('error', () => {
  stdinEof = true;
  const wake = pendingWake;
  pendingWake = null;
  wake?.();
});

let healthUrl = 'http://127.0.0.1:8766/health';

async function main() {
  // config 读取放进 main：文件缺失或损坏也要给浏览器一个应答，而不是静默退出让它干等
  const configPath = join(dirname(fileURLToPath(import.meta.url)), 'native-helper.config');
  const config = readFileSync(configPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  const [nodePath, helperPath, configuredUrl, tokenFile] = config;
  if (configuredUrl) healthUrl = configuredUrl;

  const size = await readExact(4);
  if (!size) return; // 没有消息进来就安静退出，跟 .exe 宿主一致
  const length = size.readUInt32LE(0);
  if (length < 1 || length > 4096) throw new Error('无效的本机消息');
  const body = await readExact(length);
  if (!body) throw new Error('本机消息未完整传入');
  if (!body.toString('utf8').includes('"start"')) throw new Error('不支持的操作');

  if (!(await healthy())) {
    // インストール時に記録したパスは無効になり得る（Node の更新で場所が変わった、プロジェクトを移動した等）。どれかを明示する
    if (!nodePath || !existsSync(nodePath)) throw new Error(`找不到 Node：${nodePath}`);
    if (!helperPath || !existsSync(helperPath)) throw new Error(`找不到助手脚本：${helperPath}`);
    const child = spawn(nodePath, [helperPath], { detached: true, stdio: 'ignore', windowsHide: true });
    let exited = null;
    child.on('error', (error) => { exited = `无法启动助手进程：${error.message}`; });
    child.on('exit', (code) => { exited ??= `助手进程启动后立即退出（代码 ${code}），可在项目目录运行 npm run fast-asr 查看报错`; });
    child.unref();
    // 最大 10 秒待つ：モデルのコールドスタートはホストの管轄外で、ここでは HTTP サービス自体の起動だけを待つ。プロセスが終了済みなら待たない
    for (let i = 0; i < 50 && !(await healthy()); i++) {
      if (exited && !(await healthy())) throw new Error(exited);
      await sleep(200);
    }
  }
  if (!(await healthy())) return reply(false, `助手进程 10 秒内未在 ${healthUrl} 应答`);
  reply(true, '', readToken(tokenFile));
}

/** 读取令牌文件；缺失或损坏（例如旧版助手）就不附带令牌。 */
function readToken(file) {
  try {
    const token = readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

function healthy() {
  return fetch(healthUrl, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false);
}

function reply(ok, error, token) {
  const body = Buffer.from(JSON.stringify(ok ? { ok: true, token } : { ok: false, error: String(error) }), 'utf8');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([size, body]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 stdin 精确读 n 字节；流提前结束就返回 null。不等 EOF——浏览器写完消息会握着管道等回复。 */
async function readExact(n) {
  while (pending.length < n) {
    if (stdinEof) return null;
    await new Promise((wake) => { pendingWake = wake; });
  }
  const out = pending.subarray(0, n);
  pending = pending.subarray(n);
  return out;
}

main().catch((error) => { reply(false, error?.message ?? error); });
