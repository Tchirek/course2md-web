// 可选本机桥：yt-dlp 下载音轨，ffmpeg 快速切片，再交给现有 OpenAI 兼容 ASR。
// node tools/fast-asr-server.mjs；只监听 127.0.0.1。
//
// 除 GET /health 外，所有请求都必须带访问令牌（x-c2md-token）。这个助手能读本机文件
// （file: URL）、带 Cookie 下载、启动外部程序；只看 Origin 是否以 chrome-extension://
// 开头，别的扩展也能进来。令牌只经原生消息交给本扩展——那条通道由 allowed_origins
// 限定到本扩展的 ID。
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { downloadBilibiliAudio, downloadBilibiliVideo } from './bilibili-audio.mjs';
import { SILENCE_FILTER, invertSilence, parseSilences, pcmData, rmsOfFile, speechSegments, wavFile } from './speech-segments.mjs';
import { dataDir, ensureHelperToken, removeObsoleteWhisper, sharedModelTarget, tokenPath, pythonCommand } from './helper-data.mjs';
import { cleanStaleHosts, registerHost, registrationOutdated } from './host-registration.mjs';

process.env.C2MD_PYTHON ||= pythonCommand();
if (process.platform === 'darwin' && existsSync('/etc/ssl/cert.pem')) process.env.SSL_CERT_FILE ||= '/etc/ssl/cert.pem';
process.env.PATH = [path.join(dataDir(), 'bin'), path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter);

const PORT = Number(process.env.C2MD_HELPER_PORT) || 8766;
const ASR_PORT = Number(process.env.C2MD_ASR_PORT) || 8081;
const ASR_HEALTH = `http://127.0.0.1:${ASR_PORT}/health`;
const BUILTIN_ASR = new Set([`http://127.0.0.1:${ASR_PORT}`, `http://localhost:${ASR_PORT}`]);
const MAX_BODY = 128 * 1024;
/** この助手（ポートごと）の一時ファイルの置き場。起動時に空にする。 */
const TEMP_ROOT = path.join(os.tmpdir(), `c2md-helper-${PORT}`);
const jobs = new Map();
const controllers = new Map();
const videoCache = new Map();
let asrProcess = null;
let asrStatus = { state: 'idle', message: '本机转录服务尚未启动' };
/**
 * 'auto' tries the GPU; 'cpu' after a GPU failure in the middle of a job, so the job can finish.
 * Back to 'auto' once the service exits on its own after idling.
 */
let asrDevice = process.env.C2MD_ASR_DEVICE === 'cpu' ? 'cpu' : 'auto';
let polishProcess = null;
let polishStatus = { state: 'idle', message: '本机润色尚未启动' };
ensureHelperToken();
// 升级代码后，宿主注册可能过时（旧宿主不交令牌等）。在开始监听前静默修复：拉起本助手的
// 旧宿主要等健康检查通过才应答，扩展随后再唤醒一次就会用上新宿主，用户无须重跑安装命令
try {
  const reason = registrationOutdated();
  if (reason) {
    registerHost();
    process.stdout.write(`已自动更新本机宿主注册（${reason}）\n`);
  }
  cleanStaleHosts();
} catch (error) {
  process.stderr.write(`自动更新本机宿主注册失败：${error?.message ?? error}\n`);
}
let token = { value: '', mtimeMs: -1 };

/** 当前令牌。文件被改写就重新读取，被删除就重新生成。 */
function currentToken() {
  let mtimeMs;
  try {
    ({ mtimeMs } = statSync(tokenPath()));
  } catch {
    ensureHelperToken();
    ({ mtimeMs } = statSync(tokenPath()));
  }
  if (mtimeMs !== token.mtimeMs) token = { value: ensureHelperToken(), mtimeMs };
  return token.value;
}

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-c2md-token'] ?? ''));
  let expected;
  try {
    expected = Buffer.from(currentToken());
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
fetch(ASR_HEALTH, { signal: AbortSignal.timeout(1000) })
  .then(async (reply) => { if (reply.ok) asrStatus = readyStatus(await reply.json()); })
  .catch(() => {});
fetch('http://127.0.0.1:8082/health', { signal: AbortSignal.timeout(1000) })
  .then((reply) => { if (reply.ok) polishStatus = { state: 'ready', message: '本机润色已就绪' }; })
  .catch(() => {});

http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) {
    res.writeHead(403);
    return res.end('{"error":"仅接受扩展请求"}');
  }
  if (req.method === 'GET' && req.url === '/health') return res.end('{"ok":true}');
  if (!authorized(req)) {
    res.writeHead(401);
    return res.end('{"error":"缺少或错误的访问令牌"}');
  }
  if (req.method === 'POST' && req.url === '/desktop/publish') {
    try {
      const payload = JSON.parse(await readBody(req, 64 * 1024 * 1024));
      const value = await desktopSyncRequest(payload);
      return res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  }
  if (req.method === 'GET' && req.url === '/asr/status') return res.end(JSON.stringify(asrStatus));
  if (req.method === 'GET' && req.url === '/polish/status') return res.end(JSON.stringify(polishStatus));
  if (req.method === 'POST' && req.url === '/polish/start') {
    await startLocalPolish();
    return res.end(JSON.stringify(polishStatus));
  }
  if (req.method === 'POST' && req.url === '/asr/start') {
    await startLocalAsr();
    return res.end(JSON.stringify(asrStatus));
  }
  if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const job = jobs.get(url.pathname.slice(6));
    if (!job) res.writeHead(404);
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const imageAfter = Math.max(0, Number(url.searchParams.get('imageAfter')) || 0);
    return res.end(JSON.stringify(job ? { ...job, events: job.events.slice(after), images: job.images.slice(imageAfter) } : { error: '任务不存在' }));
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/jobs/')) {
    const controller = controllers.get(req.url.slice(6));
    controller?.abort();
    return res.end(JSON.stringify({ cancelled: Boolean(controller) }));
  }
  if (req.method !== 'POST' || !['/transcribe', '/frames'].includes(req.url)) {
    res.writeHead(404);
    return res.end('{"error":"not found"}');
  }
  try {
    const input = JSON.parse(await readBody(req));
    const source = new URL(input.sourceUrl);
    if (!['http:', 'https:', 'file:'].includes(source.protocol)) throw new Error('不支持此视频地址');
    const frames = req.url === '/frames';
    const endpoint = frames ? null : new URL(input.endpoint);
    if (endpoint && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
      throw new Error('ASR 服务必须在本机');
    }
    const id = randomUUID();
    const job = { state: 'running', message: source.protocol === 'file:' ? '正在读取本地视频' : '正在下载媒体', done: 0, total: 0, events: [], images: [], warnings: [] };
    const controller = new AbortController();
    jobs.set(id, job);
    controllers.set(id, controller);
    (frames ? processFrames(input, source, job, controller.signal) : processJob(input, source, endpoint, job, controller.signal)).then(
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
  // 端口已归本进程：同一端口不会有另一个助手在用这些临时文件
  sweepStaleTemp();
  // 更新代码不会重跑安装：旧版的 faster-whisper 环境在这里清掉（与宿主注册的自动修复同理）
  try {
    removeObsoleteWhisper((target) => process.stdout.write(`已删除不再使用的 faster-whisper 转录环境与模型：${target}\n`));
  } catch (error) {
    process.stderr.write(`清理旧版转录环境失败：${error?.message ?? error}\n`);
  }
  process.stdout.write(`course2md 本机提取服务：http://127.0.0.1:${PORT}\n`);
});

/**
 * 上一个助手被强制结束时留下的临时文件（下载到一半的媒体、画面缓存、cookie）。
 * 平时它们在任务结束或一小时后删除；进程提前退出就等不到，所以启动时清一次。
 * 同步执行，赶在第一个请求之前。
 */
function sweepStaleTemp() {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
  if (PORT !== 8766) return;
  // 旧版助手直接放在系统临时目录里（mkdtemp 的 c2md-XXXXXX、c2md-video-XXXXXX），取帧的还夹着登录 cookie
  for (const name of readdirSync(os.tmpdir())) {
    if (/^c2md-(?:video-)?[A-Za-z0-9]{6}$/.test(name)) rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
}

/**
 * 调用 yt-dlp。给了浏览器登录态时，cookie 只在 yt-dlp 运行期间存在：写进单独的临时目录，
 * yt-dlp 一退出（成功、失败或取消）就删掉。以前取帧路径把它和视频缓存放在一起，要等一小时，
 * 助手在那之前退出的话，登录 cookie 就一直留在临时目录里。
 */
async function ytDlp(args, url, cookieFile, signal) {
  if (process.platform === 'win32' && existsSync(path.join(dataDir(), 'bin', 'yt-dlp.exe'))) args = ['--js-runtimes', `node:${process.execPath}`, ...args];
  if (!cookieFile) return run('yt-dlp', [...args, '--', url], signal);
  const dir = await mkdtemp(path.join(TEMP_ROOT, 'cookies-'));
  try {
    const cookiePath = path.join(dir, 'cookies.txt');
    await writeFile(cookiePath, cookieFile, { mode: 0o600 });
    return await run('yt-dlp', [...args, '--cookies', cookiePath, '--', url], signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function processFrames(input, source, job, signal) {
  let mediaPath = source.protocol === 'file:' ? fileURLToPath(source) : videoCache.get(source.href)?.file;
  if (!mediaPath) {
    const dir = await mkdtemp(path.join(TEMP_ROOT, 'video-'));
    try {
      if (source.hostname === 'www.bilibili.com') {
        try {
          mediaPath = await downloadBilibiliVideo(source, dir, signal, (message) => { job.message = message; });
        } catch (error) {
          if (signal.aborted) throw error;
          job.message = '备用画面线路失败，正在尝试 yt-dlp';
        }
      }
      if (!mediaPath) {
        // 取帧优先 H.264：YouTube 的 720p 常是 AV1，老版本 ffmpeg 一解码就崩溃（实测 4.2 段错误）；
        // 截图不需要高码率，H.264 几乎所有 ffmpeg 都能解。没有 H.264 才退回其他编码
        const format = 'bestvideo[height<=720][vcodec^=avc1]/best[height<=720][vcodec^=avc1]/bestvideo[height<=720]/best[height<=720]';
        const args = ['--ignore-config', '--socket-timeout', '12', '--js-runtimes', 'node', '--no-playlist', '-f', format, '-o', path.join(dir, 'input.%(ext)s')];
        await ytDlp(args, source.href, input.cookieFile, signal);
        const name = (await readdir(dir)).find((entry) => entry.startsWith('input.') && !entry.endsWith('.part'));
        if (!name) throw new Error('yt-dlp 未取得视频画面');
        mediaPath = path.join(dir, name);
      }
      videoCache.set(source.href, { file: mediaPath, dir });
      setTimeout(async () => {
        if (videoCache.get(source.href)?.dir === dir) videoCache.delete(source.href);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }, 3600_000);
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  const times = [...new Set((input.times ?? []).map(Number).filter((t) => Number.isFinite(t) && t >= 0))];
  job.total = times.length;
  for (const time of times) {
    if (signal.aborted) throw new Error('已取消');
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', mediaPath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'];
    const bytes = await runOutput('ffmpeg', args, signal);
    job.images.push({ time, data: `data:image/jpeg;base64,${bytes.toString('base64')}` });
    job.done++;
  }
  return { images: job.images };
}

function runOutput(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
    child.on('error', reject);
    child.on('exit', (code) => {
      signal.removeEventListener('abort', abort);
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr || exitReason(command, code)));
    });
  });
}

/** 退出码翻译成人话：Windows 上 3221225477（0xC0000005）是进程崩溃，多半是 ffmpeg 版本过旧解不了这种编码。 */
function exitReason(command, code) {
  if (code === 3221225477 || code === -1073741819 || code === 139) {
    return `${command} 崩溃了（退出码 ${code}），多半是版本过旧、解不了该视频的编码；请升级 ${command}`;
  }
  return `${command} 退出码 ${code}`;
}

async function startLocalAsr() {
  if (asrProcess && ['starting', 'downloading', 'loading', 'ready'].includes(asrStatus.state)) return;
  try {
    const existing = await fetch(ASR_HEALTH, { signal: AbortSignal.timeout(1000) });
    if (existing.ok) {
      asrStatus = readyStatus(await existing.json());
      return;
    }
  } catch { /* 尚无本机模型服务，继续启动 */ }
  // Concurrent callers may both have awaited the health probe before either one spawned.
  if (asrProcess) return;
  spawnLocalAsr();
}

function spawnLocalAsr() {
  asrStatus = { state: 'starting', message: '正在检查本机模型' };
  // Only the standard library: the model and llama.cpp are shared with the original course2md (qwen-asr.py)
  const python = process.env.C2MD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const child = spawn(python, ['-u', fileURLToPath(new URL('./qwen-asr.py', import.meta.url))], {
    windowsHide: true,
    env: {
      ...process.env, C2MD_ASR_PORT: String(ASR_PORT), C2MD_DATA_DIR: dataDir(), C2MD_ASR_DEVICE: asrDevice,
      ...(sharedModelTarget() ? { C2MD_SHARED_MODEL_TARGET: sharedModelTarget() } : {}),
    },
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
      if (asrProcess !== child) continue;
      try { asrStatus = JSON.parse(line); } catch { /* 模型库的普通输出 */ }
    }
  });
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-800); });
  // 状態を書き換えるのは今の子プロセスだけ。空き時間で終わった旧プロセスの exit が、
  // その間に起動し直した新しいプロセスの状態を上書きしないようにする
  child.on('error', (error) => {
    if (asrProcess !== child) return;
    asrStatus = { state: 'error', message: `无法启动 Python：${error.message}` };
    asrProcess = null;
  });
  child.on('exit', (code) => {
    if (asrProcess !== child) return;
    // 空き時間での自発的な終了（state: idle）はエラーではない。次に使うとき起動し直す
    if (asrStatus.state === 'idle') asrDevice = 'auto';
    if (!['error', 'idle'].includes(asrStatus.state)) asrStatus = { state: 'error', message: errors || `转录服务退出：${code}` };
    asrProcess = null;
  });
}

async function startLocalPolish() {
  if (polishProcess && ['starting', 'installing', 'downloading', 'loading', 'ready'].includes(polishStatus.state)) return;
  try {
    const reply = await fetch('http://127.0.0.1:8082/health', { signal: AbortSignal.timeout(700) });
    if (reply.ok) {
      polishStatus = { state: 'ready', message: '本机润色已就绪' };
      return;
    }
  } catch { /* 尚未运行 */ }
  polishStatus = { state: 'starting', message: '正在准备本机润色' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('./launch-local-polish.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, C2MD_DATA_DIR: dataDir() },
  });
  polishProcess = child;
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    for (let newline = output.indexOf('\n'); newline >= 0; newline = output.indexOf('\n')) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (polishProcess !== child) continue;
      try { polishStatus = JSON.parse(line); } catch { /* 安装程序输出 */ }
    }
  });
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-1000); });
  child.on('error', (error) => {
    if (polishProcess !== child) return;
    polishStatus = { state: 'error', message: error.message };
    polishProcess = null;
  });
  child.on('exit', (code) => {
    if (polishProcess !== child) return;
    if (!['error', 'idle'].includes(polishStatus.state)) polishStatus = { state: 'error', message: errors || `本机润色服务退出：${code}` };
    polishProcess = null;
  });
}

function readyStatus(health) {
  return { state: 'ready', model: health.model, device: health.device, note: health.note ?? '', message: `本机转录服务已启动（${health.device === 'cuda' ? '显卡' : 'CPU'}）` };
}

async function processJob(input, source, endpoint, job, signal) {
  let dir;
  try {
    if (BUILTIN_ASR.has(endpoint.origin)) await startLocalAsr();
    const chunkSeconds = Math.max(5, Math.min(120, Number(input.chunkSeconds) || 30));
    dir = await mkdtemp(path.join(TEMP_ROOT, 'job-'));
    let mediaPath;
    if (source.protocol === 'file:') {
      mediaPath = fileURLToPath(source);
    } else {
      const args = ['--ignore-config', '--socket-timeout', '12', '--js-runtimes', 'node', '--no-playlist', '-f', 'bestaudio/best', '-o', path.join(dir, 'input.%(ext)s')];
      let backupError;
      if (source.hostname === 'www.bilibili.com') {
        try {
          mediaPath = await downloadBilibiliAudio(source, dir, signal, (message) => { job.message = message; });
        } catch (error) {
          if (signal.aborted) throw error;
          backupError = error;
        }
      }
      if (!mediaPath) {
        if (input.cookieFile) job.message = '正在使用浏览器登录态下载音轨';
        try {
          await ytDlp(args, source.href, input.cookieFile, signal);
        } catch (error) {
          throw new Error(backupError ? `${backupError.message}; ${error.message}` : error.message);
        }
      }
      if (!mediaPath) {
        const downloaded = (await readdir(dir)).find((name) => name.startsWith('input.') && !name.endsWith('.part'));
        if (!downloaded) throw new Error('yt-dlp 未产出音轨');
        mediaPath = path.join(dir, downloaded);
      }
    }
    job.message = '正在切分音轨';
    const audioPath = path.join(dir, 'audio.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath], signal);
    const audio = await open(audioPath, 'r');
    try {
      // 内蔵の Qwen3-ASR は 20 秒ずつ受け取る（原版の max_speech と同じ）。自前の ASR には設定の長さまで
      const maxSpeech = BUILTIN_ASR.has(endpoint.origin) ? Math.min(chunkSeconds, 20) : chunkSeconds;
      const segments = await speechPlan(audio, audioPath, maxSpeech, signal);
      job.total = segments.length;
      // The device the service runs on, remembered here: after a GPU failure the service reports only the error
      let serviceDevice = null;
      if (BUILTIN_ASR.has(endpoint.origin)) {
        await waitForLocalAsr(job, signal);
        serviceDevice = asrStatus.device;
        if (asrStatus.note) job.warnings.push(asrStatus.note);
      }
      const data = pcmData(await readHead(audio));
      const events = job.events;
      let restarts = 0;
      for (let i = 0; i < segments.length; i++) {
        if (signal.aborted) throw new Error('已取消');
        job.message = `正在转写 ${i + 1}/${segments.length} 段`;
        const segment = segments[i];
        const from = Math.floor(segment.cutStart * 16000) * 2;
        const pcm = Buffer.alloc(Math.max(0, Math.min(data.bytes, Math.ceil(segment.cutEnd * 16000) * 2) - from));
        await audio.read(pcm, 0, pcm.length, data.offset + from);
        const bytes = wavFile(pcm);
        const request = (format) => {
          const form = new FormData();
          form.set('file', new Blob([bytes], { type: 'audio/wav' }), `part-${String(i).padStart(5, '0')}.wav`);
          form.set('model', String(input.model || 'whisper-1'));
          form.set('response_format', format);
          form.set('temperature', '0');
          if (input.prompt) form.set('prompt', String(input.prompt).slice(0, 200));
          if (input.language) form.set('language', String(input.language));
          return fetch(endpoint, {
            method: 'POST',
            headers: input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {},
            body: form,
            signal,
          });
        };
        const attempt = async () => {
          let reply = await request('verbose_json');
          if (reply.status === 400 || reply.status === 422) reply = await request('json');
          if (reply.ok) return reply;
          throw new Error(`HTTP ${reply.status} ${errorText(await reply.text())}`);
        };
        let reply;
        try {
          reply = await attempt();
        } catch (error) {
          if (signal.aborted) throw error;
          // 内蔵 ASR はメモリや CUDA の失敗で使えなくなる（その場合は自ら終了する）。
          // 新しいプロセスなら CUDA コンテキストも作り直されるので、同じ切片を一度だけやり直す
          if (!BUILTIN_ASR.has(endpoint.origin) || restarts >= 3) throw new Error(`ASR 第 ${i + 1} 段失败：${error.message}`);
          restarts++;
          if (serviceDevice === 'cuda') {
            // A GPU failure tends to repeat on the same input. Finish the job on the CPU instead of failing it
            asrDevice = 'cpu';
            job.message = `显卡转录出错，正在改用 CPU 重试第 ${i + 1} 段`;
            job.warnings.push(`显卡转录第 ${i + 1} 段出错，已改用 CPU 继续（较慢）：${error.message.slice(0, 160)}`);
          } else {
            job.message = `本机转录服务出错（${error.message}），正在重启后重试第 ${i + 1} 段`;
          }
          await restartLocalAsr(job, signal);
          serviceDevice = asrStatus.device;
          try {
            reply = await attempt();
          } catch (retryError) {
            if (signal.aborted) throw retryError;
            throw new Error(`ASR 第 ${i + 1} 段失败（已重启本机转录服务重试）：${retryError.message}`);
          }
        }
        const value = await reply.json();
        // 応答の時刻は切り出した音声の頭（無音の余白を含む）から数える。発話の範囲に収める
        const within = (t) => Math.min(segment.end, Math.max(segment.start, segment.cutStart + (Number(t) || 0)));
        if (Array.isArray(value.segments) && value.segments.length) {
          for (const part of value.segments) {
            if (part.text) events.push({ start: within(part.start), end: within(part.end), text: part.text });
          }
        } else if (value.text) {
          events.push({ start: segment.start, end: segment.end, text: value.text });
        }
        job.done = i + 1;
      }
      return { events, chunks: segments.length };
    } finally {
      await audio.close();
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 音声のどこを送るか：無音で区切った発話（原版と同じ規則、speech-segments.mjs）。
 * 無音検出が発話を一つも見つけないのに音はある（声がとても小さい録音など）ときは、
 * 何も書かずに終わるより全体を発話として扱う。
 * @param {import('node:fs/promises').FileHandle} audio
 */
async function speechPlan(audio, audioPath, maxSpeech, signal) {
  const data = pcmData(await readHead(audio));
  const duration = data.bytes / 32000;
  const log = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', audioPath, '-af', SILENCE_FILTER, '-f', 'null', '-'], signal, { log: true });
  const rms = await rmsOfFile(audio, data);
  const segments = speechSegments(invertSilence(duration, parseSilences(log)), maxSpeech, rms, duration);
  if (segments.length || !rms.some((value) => value >= 0.005)) return segments;
  return speechSegments([[0, duration]], maxSpeech, rms, duration);
}

/**
 * WAV の先頭と PCM の位置。長さ欄が実際より長い（書きかけ等）ときはファイルの大きさに合わせる。
 * @param {import('node:fs/promises').FileHandle} audio
 */
async function readHead(audio) {
  const head = Buffer.alloc(4096);
  const { bytesRead } = await audio.read(head, 0, head.length, 0);
  const { size } = await audio.stat();
  const data = pcmData(head.subarray(0, bytesRead));
  const bytes = Math.max(0, Math.min(data.bytes, size - data.offset)) & ~1;
  // pcmData が読み直すための先頭：長さ欄を実際の値に書き換えておく
  const fixed = Buffer.from(head.subarray(0, bytesRead));
  fixed.writeUInt32LE(bytes, data.offset - 4);
  return fixed;
}

/** 本機 ASR のプロセスを終わらせてから起動し直し、準備完了まで待つ。 */
async function restartLocalAsr(job, signal) {
  const old = asrProcess;
  if (old && old.exitCode === null && old.signalCode === null) {
    const exited = new Promise((resolve) => old.once('exit', resolve));
    old.kill();
    await exited;
  }
  asrProcess = null;
  asrStatus = { state: 'idle', message: '正在重启本机转录服务' };
  await startLocalAsr();
  await waitForLocalAsr(job, signal);
}

/** ASR の応答本文から人が読めるエラー文を取り出す（JSON の error を優先）。 */
function errorText(body) {
  try {
    const message = JSON.parse(body)?.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
    if (message?.message) return String(message.message).slice(0, 300);
  } catch { /* JSON ではない */ }
  return body.trim().slice(0, 200) || '（服务未给出原因）';
}

async function waitForLocalAsr(job, signal) {
  while (asrStatus.state !== 'ready') {
    if (signal.aborted) throw new Error('已取消');
    // 長いダウンロードの間に空き時間で終わっていたら起動し直す
    if (asrStatus.state === 'idle' && !asrProcess) await startLocalAsr();
    if (asrStatus.state === 'error') throw new Error(asrStatus.message);
    job.message = asrStatus.message || '正在加载本机转录模型';
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function desktopSyncRequest(payload) {
  return new Promise((resolve, reject) => {
    const python = process.env.C2MD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const child = spawn(python, ['-u', fileURLToPath(new URL('./desktop_sync.py', import.meta.url))], {
      windowsHide: true, env: { ...process.env, C2MD_DATA_DIR: dataDir() }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('同步超时，请重试')); }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 64 * 1024 * 1024) { child.kill(); reject(new Error('课程文件过大')); }
    });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output);
        if (code || value.error) throw new Error(value.error || errors || '同步失败');
        resolve(value);
      } catch (error) { reject(error); }
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {AbortSignal} signal
 * @param {{log?: boolean}} [options] log: stderr を全部返す（ffmpeg の無音検出の結果はそこに出る）
 * @returns {Promise<string>}
 */
function run(command, args, signal, { log = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let errorText = '';
    let full = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errorText = (errorText + chunk).slice(-1200);
      if (log && full.length < 32 * 1024 * 1024) full += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      signal.removeEventListener('abort', onAbort);
      code === 0 ? resolve(full) : reject(new Error(signal.aborted ? "已取消" : `${command} 失败：${errorText || exitReason(command, code)}`));
    });
  });
}
