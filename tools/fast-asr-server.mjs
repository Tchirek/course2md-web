// 可选本机桥：yt-dlp 下载音轨，ffmpeg 快速切片，再交给现有 OpenAI 兼容 ASR。
// node tools/fast-asr-server.mjs；只监听 127.0.0.1。
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = 8765;
const MAX_BODY = 128 * 1024;
const jobs = new Map();
const controllers = new Map();
let asrProcess = null;
let asrStatus = { state: 'idle', message: '本机转录服务尚未启动' };

http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) {
    res.writeHead(403);
    return res.end('{"error":"仅接受扩展请求"}');
  }
  if (req.method === 'GET' && req.url === '/health') return res.end('{"ok":true}');
  if (req.method === 'GET' && req.url === '/asr/status') return res.end(JSON.stringify(asrStatus));
  if (req.method === 'POST' && req.url === '/asr/start') {
    startLocalAsr();
    return res.end(JSON.stringify(asrStatus));
  }
  if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
    const job = jobs.get(req.url.slice(6));
    if (!job) res.writeHead(404);
    return res.end(JSON.stringify(job ?? { error: '任务不存在' }));
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/jobs/')) {
    const controller = controllers.get(req.url.slice(6));
    controller?.abort();
    return res.end(JSON.stringify({ cancelled: Boolean(controller) }));
  }
  if (req.method !== 'POST' || req.url !== '/transcribe') {
    res.writeHead(404);
    return res.end('{"error":"not found"}');
  }
  try {
    const input = JSON.parse(await readBody(req));
    const source = new URL(input.sourceUrl);
    const endpoint = new URL(input.endpoint);
    if (!['http:', 'https:', 'file:'].includes(source.protocol)) throw new Error('不支持此视频地址');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
      throw new Error('ASR 服务必须在本机');
    }
    const id = randomUUID();
    const job = { state: 'running', message: source.protocol === 'file:' ? '正在读取本地视频' : '正在下载音轨', done: 0, total: 0 };
    const controller = new AbortController();
    jobs.set(id, job);
    controllers.set(id, controller);
    processJob(input, source, endpoint, job, controller.signal).then(
      (value) => Object.assign(job, { state: 'done', ...value }),
      (error) => Object.assign(job, { state: 'error', error: String(error?.message ?? error) }),
    ).finally(() => {
      controllers.delete(id);
      setTimeout(() => jobs.delete(id), 3600_000);
    });
    res.end(JSON.stringify({ id }));
  } catch (error) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(error?.message ?? error) }));
  }
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`course2md 本机提取服务：http://127.0.0.1:${PORT}\n`);
});

function startLocalAsr() {
  if (asrProcess && ['starting', 'downloading', 'loading', 'ready'].includes(asrStatus.state)) return;
  asrStatus = { state: 'starting', message: '正在检查本机模型' };
  const child = spawn(process.env.C2MD_PYTHON || 'python', ['-u', fileURLToPath(new URL('./local-asr.py', import.meta.url))], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  asrProcess = child;
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    for (let newline = output.indexOf('\n'); newline >= 0; newline = output.indexOf('\n')) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      try { asrStatus = JSON.parse(line); } catch { /* 模型库的普通输出 */ }
    }
  });
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-800); });
  child.on('error', (error) => {
    asrStatus = { state: 'error', message: `无法启动 Python：${error.message}` };
    asrProcess = null;
  });
  child.on('exit', (code) => {
    if (asrStatus.state !== 'error') asrStatus = { state: 'error', message: errors || `转录服务退出：${code}` };
    asrProcess = null;
  });
}

async function processJob(input, source, endpoint, job, signal) {
  let dir;
  try {
    const chunkSeconds = Math.max(5, Math.min(120, Number(input.chunkSeconds) || 30));
    dir = await mkdtemp(path.join(os.tmpdir(), 'c2md-'));
    let mediaPath;
    if (source.protocol === 'file:') {
      mediaPath = fileURLToPath(source);
    } else {
      const args = ['--ignore-config', '--socket-timeout', '12', '--js-runtimes', 'node', '--no-playlist', '-f', 'bestaudio/best', '-o', path.join(dir, 'input.%(ext)s')];
      try {
        await run('yt-dlp', [...args, '--', source.href], signal);
      } catch (error) {
        if (!input.cookieFile || !String(error.message).startsWith('yt-dlp 失败') || signal.aborted) throw error;
        job.message = '正在使用浏览器登录态重试下载';
        const cookiePath = path.join(dir, 'cookies.txt');
        await writeFile(cookiePath, input.cookieFile, { mode: 0o600 });
        await run('yt-dlp', [...args, '--cookies', cookiePath, '--', source.href], signal);
      }
      const downloaded = (await readdir(dir)).find((name) => name.startsWith('input.') && !name.endsWith('.part'));
      if (!downloaded) throw new Error('yt-dlp 未产出音轨');
      mediaPath = path.join(dir, downloaded);
    }
    job.message = '正在切分音轨';
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(chunkSeconds), path.join(dir, 'part-%05d.wav')], signal);
    const files = (await readdir(dir)).filter((name) => /^part-\d+\.wav$/.test(name)).sort();
    if (!files.length) throw new Error('ffmpeg 未产出音频切片');
    job.total = files.length;
    const events = [];
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) throw new Error('已取消');
      job.message = `正在转写 ${i + 1}/${files.length} 片`;
      const bytes = await readFile(path.join(dir, files[i]));
      const request = (format) => {
        const form = new FormData();
        form.set('file', new Blob([bytes], { type: 'audio/wav' }), files[i]);
        form.set('model', String(input.model || 'whisper-1'));
        form.set('response_format', format);
        form.set('temperature', '0');
        if (input.language) form.set('language', String(input.language));
        return fetch(endpoint, {
          method: 'POST',
          headers: input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {},
          body: form,
          signal,
        });
      };
      let reply = await request('verbose_json');
      if (reply.status === 400 || reply.status === 422) reply = await request('json');
      if (!reply.ok) throw new Error(`ASR 第 ${i + 1} 片失败：HTTP ${reply.status} ${(await reply.text()).slice(0, 200)}`);
      const value = await reply.json();
      const start = i * chunkSeconds;
      if (Array.isArray(value.segments) && value.segments.length) {
        for (const segment of value.segments) {
          if (segment.text) events.push({ start: start + Number(segment.start || 0), end: start + Number(segment.end || 0), text: segment.text });
        }
      } else if (value.text) {
        events.push({ start, end: start + chunkSeconds, text: value.text });
      }
      job.done = i + 1;
    }
    return { events, chunks: files.length };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('请求过大');
  }
  return body;
}

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let errorText = '';
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk).slice(-1200); });
    child.on('error', reject);
    child.on('exit', (code) => {
      signal.removeEventListener('abort', onAbort);
      code === 0 ? resolve() : reject(new Error(signal.aborted ? '已取消' : `${command} 失败：${errorText || `退出码 ${code}`}`));
    });
  });
}
