// The transcription service's own Python environment (data dir/asr/venv).
//
// It used to run in whatever Python the user had, importing PyTorch only to borrow its CUDA DLLs.
// That made the GPU path a patchwork: CTranslate2 4.8.1 is built with CUDA 12.8 but ran on the
// cuBLAS 12.1 inside PyTorch, and its bundled cudnn64_9.dll (9.10.2) loaded the rest of cuDNN
// from PyTorch (9.1.0). Some matrix shapes then failed with CUBLAS_STATUS_NOT_SUPPORTED, and any
// new CTranslate2 release pulled in by pip could change the picture again.
//
// Now every package is pinned (runtime-pins.json → asr-python), and on machines with an NVIDIA GPU
// the matching cuBLAS / cuDNN come from NVIDIA's own wheels, pinned by SHA-256 (→ cuda-runtime).
// local-asr.py loads exactly those and checks that it did; otherwise it transcribes on the CPU.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './helper-data.mjs';
import { withLock } from './install-lock.mjs';

const PINS = JSON.parse(readFileSync(new URL('./runtime-pins.json', import.meta.url), 'utf8'));
const isWin = process.platform === 'win32';
/** Space the downloads and the installed files need, with some margin (GB). */
const NEED_CPU_GB = 1;
const NEED_GPU_GB = 4.5;

export function asrHome() {
  return path.join(dataDir(), 'asr');
}

export function asrPython(home = asrHome()) {
  return path.join(home, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
}

/** runtime-pins.json platform key, e.g. win32-x64, linux-x64, darwin-arm64. */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** The pinned CUDA wheels for this platform, or none (no NVIDIA wheels for it). */
export function cudaWheels(key = platformKey()) {
  return Object.entries(PINS['cuda-runtime'].wheels)
    .filter(([, pin]) => pin.files[key])
    .map(([name, pin]) => ({ package: name, version: pin.version, file: pin.files[key].name, size: pin.files[key].size, sha256: pin.files[key].sha256 }));
}

/** Whether an NVIDIA GPU with a working driver is present. */
export function hasNvidiaGpu() {
  if (!cudaWheels().length) return false;
  const probe = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return probe.status === 0 && /GPU \d+:/.test(probe.stdout);
}

/** pip constraints: every package at its pinned version. */
export function constraintsText() {
  return Object.entries(PINS['asr-python'].packages).map(([name, version]) => `${name}==${version}`).join('\n') + '\n';
}

/** What the environment must match: the pins, and whether the GPU libraries belong in it. */
export function expectedStamp(gpu) {
  const pins = { python: PINS['asr-python'], cuda: gpu ? PINS['cuda-runtime'].wheels : null };
  return createHash('sha256').update(JSON.stringify(pins)).digest('hex');
}

function stampFile(home) {
  return path.join(home, 'venv', 'c2md-asr.json');
}

export function readStamp(home = asrHome()) {
  try {
    return JSON.parse(readFileSync(stampFile(home), 'utf8'));
  } catch {
    return null;
  }
}

/** The environment is installed and matches the current pins (GPU libraries included when there is a GPU). */
export function asrRuntimeReady(home = asrHome(), gpu = hasNvidiaGpu()) {
  const stamp = readStamp(home);
  if (!stamp || !existsSync(asrPython(home))) return false;
  if (stamp.stamp === expectedStamp(gpu)) return true;
  // Installed without the GPU libraries because the disk was too full: usable as is, retried when space frees up
  return gpu && stamp.stamp === expectedStamp(false) && !enoughSpace(home, NEED_GPU_GB);
}

function freeGB(dir) {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize / 1e9;
  } catch {
    return Infinity;
  }
}

function enoughSpace(dir, gb) {
  return freeGB(existsSync(dir) ? dir : path.parse(path.resolve(dir)).root) >= gb;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Where PyPI serves a pinned file (its JSON API knows the path on files.pythonhosted.org). */
async function pypiUrl(wheel) {
  const reply = await fetch(`https://pypi.org/pypi/${wheel.package}/${wheel.version}/json`, { signal: AbortSignal.timeout(30_000) });
  if (!reply.ok) throw new Error(`PyPI ${reply.status}`);
  const file = (await reply.json()).urls.find((entry) => entry.filename === wheel.file);
  if (!file) throw new Error(`PyPI 上没有 ${wheel.file}`);
  return file.url;
}

/**
 * Downloads url to target, resuming a partial file with Range requests. Gives up only after ten
 * attempts in a row that make no progress (a slow or dropping line still gets there).
 */
async function resumableDownload(url, target, onBytes) {
  const part = `${target}.part`;
  let stalled = 0;
  for (;;) {
    const done = existsSync(part) ? statSync(part).size : 0;
    try {
      const reply = await fetch(url, { headers: done ? { range: `bytes=${done}-` } : {}, signal: AbortSignal.timeout(120_000) });
      if (reply.status === 416) break; // already complete
      if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
      const resume = reply.status === 206;
      const total = resume
        ? Number(reply.headers.get('content-range')?.split('/')[1]) || 0
        : Number(reply.headers.get('content-length')) || 0;
      const sink = createWriteStream(part, { flags: resume ? 'a' : 'w' });
      let got = resume ? done : 0;
      // a stuck connection (no bytes for a minute) is dropped and resumed
      let idle = setTimeout(() => sink.destroy(new Error('一分钟没有收到数据')), 60_000);
      try {
        for await (const chunk of reply.body) {
          clearTimeout(idle);
          idle = setTimeout(() => sink.destroy(new Error('一分钟没有收到数据')), 60_000);
          if (!sink.write(chunk)) await new Promise((resolve) => sink.once('drain', resolve));
          got += chunk.length;
          onBytes(got, total);
        }
      } finally {
        clearTimeout(idle);
        await new Promise((resolve) => sink.end(resolve));
      }
      if (!total || statSync(part).size >= total) break;
    } catch (error) {
      stalled = (existsSync(part) ? statSync(part).size : 0) > done ? 0 : stalled + 1;
      if (stalled >= 10) throw new Error(`下载连续 10 次没有进展：${error?.message ?? error}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  renameSync(part, target);
}

/**
 * Fetches one pinned CUDA wheel into dir and checks its SHA-256. PyPI first, resumable, with progress;
 * if PyPI cannot be reached, pip fetches it through the user's configured index (a mirror, often).
 */
async function fetchWheel(python, wheel, dir, env, onProgress) {
  const target = path.join(dir, wheel.file);
  if (existsSync(target) && await sha256File(target) === wheel.sha256) return target;
  rmSync(target, { force: true });
  try {
    await resumableDownload(await pypiUrl(wheel), target, onProgress);
  } catch {
    rmSync(`${target}.part`, { force: true });
    const requirement = path.join(dir, `${wheel.package}.txt`);
    writeFileSync(requirement, `${wheel.package}==${wheel.version} --hash=sha256:${wheel.sha256}
`);
    const fetched = await run(python, ['-m', 'pip', 'download', '--no-deps', '--require-hashes', '-r', requirement, '-d', dir], { env });
    if (fetched.code !== 0) throw new Error(`下载 ${wheel.file} 失败：${fetched.tail.trim().slice(-300)}`);
  }
  if (await sha256File(target) !== wheel.sha256) {
    rmSync(target, { force: true });
    throw new Error(`${wheel.file} 与固定版本的 SHA-256 不符，已删除`);
  }
  return target;
}

/** Runs a command; resolves with its exit code. Output goes to onLine (pip's download progress etc.). */
function run(command, args, { env, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const take = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n|\r/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, tail }));
  });
}

async function basePython() {
  const python = process.env.C2MD_PYTHON || (isWin ? 'python' : 'python3');
  const probe = await run(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']).catch(() => null);
  const version = probe?.code === 0 ? probe.tail.trim().split(/\s+/).pop() : null;
  if (!version) throw new Error(`找不到 Python（${python}）。本机转录需要 Python 3.10–3.13`);
  const [major, minor] = version.split('.').map(Number);
  if (major !== 3 || minor < 10 || minor > 13) {
    throw new Error(`本机转录需要 Python 3.10–3.13，当前是 ${version}（${python}）。可用环境变量 C2MD_PYTHON 指定其他 Python`);
  }
  return python;
}

/**
 * Installs (or brings up to date) the transcription environment. Idempotent; one installer at a time.
 * @param {{ onState?: (state: string, message: string) => void, onLine?: (line: string) => void }} [options]
 * @returns {Promise<{ gpu: boolean, note: string }>}
 */
export async function ensureAsrRuntime({ onState = () => {}, onLine = () => {} } = {}) {
  const home = asrHome();
  mkdirSync(home, { recursive: true });
  return withLock(path.join(home, '.install.lock'), async () => {
    let gpu = hasNvidiaGpu();
    let note = '';
    if (gpu && !enoughSpace(home, NEED_GPU_GB)) {
      gpu = false;
      note = `数据目录所在的盘剩余不足 ${NEED_GPU_GB} GB，暂不安装显卡加速库，本机转录改用 CPU（较慢）。` +
        '腾出空间或把数据目录移到空闲的盘（npm run local:install -- --data-dir <目录>）后会自动补装';
    }
    if (readStamp(home)?.stamp === expectedStamp(gpu) && existsSync(asrPython(home))) return { gpu, note };
    if (!enoughSpace(home, NEED_CPU_GB)) {
      throw new Error(`数据目录所在的盘剩余不足 ${NEED_CPU_GB} GB，无法安装本机转录环境。请清理磁盘，或把数据目录移到空闲的盘：npm run local:install -- --data-dir <目录>`);
    }

    // pip downloads into TEMP before installing: keep those hundreds of MB on the data drive too
    const tmp = path.join(home, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONIOENCODING: 'utf-8' };
    const python = asrPython(home);
    try {
      if (!existsSync(python)) {
        onState('installing', '正在准备本机转录环境');
        const created = await run(await basePython(), ['-m', 'venv', path.join(home, 'venv')], { env, onLine });
        if (created.code !== 0) throw new Error(`无法创建本机转录环境：${created.tail.trim().slice(-300)}`);
      }
      const constraints = path.join(home, 'constraints.txt');
      writeFileSync(constraints, constraintsText());
      onState('installing', '正在安装本机转录运行库（版本已固定）');
      const pkgs = PINS['asr-python'].packages;
      const installed = await run(python, ['-m', 'pip', 'install', '--no-cache-dir', '-c', constraints,
        `faster-whisper==${pkgs['faster-whisper']}`, `ctranslate2==${pkgs.ctranslate2}`], { env, onLine });
      if (installed.code !== 0) throw new Error(`安装本机转录运行库失败：${installed.tail.trim().slice(-400)}`);
      if (gpu) {
        // Kept across interrupted runs so a resumed install continues the download instead of restarting it
        const downloads = path.join(home, 'downloads');
        mkdirSync(downloads, { recursive: true });
        const wheels = cudaWheels();
        const totalMB = wheels.reduce((sum, wheel) => sum + wheel.size, 0);
        const files = [];
        let before = 0;
        let shown = -1;
        for (const wheel of wheels) {
          files.push(await fetchWheel(python, wheel, downloads, env, (got) => {
            const percent = Math.floor(((before + got / 1e6) / totalMB) * 100);
            if (percent === shown) return;
            shown = percent;
            onState('installing', `正在下载显卡加速库 ${Math.min(99, percent)}%（约 ${Math.round(totalMB / 100) / 10} GB，只需一次）`);
          }));
          before += wheel.size;
        }
        onState('installing', '正在安装显卡加速库');
        // verified above; installed from the local files only
        const cuda = await run(python, ['-m', 'pip', 'install', '--no-cache-dir', '--no-deps', '--no-index', ...files], { env, onLine });
        if (cuda.code !== 0) throw new Error(`安装显卡加速库失败：${cuda.tail.trim().slice(-400)}`);
        rmSync(downloads, { recursive: true, force: true });
      }
      const check = await run(python, ['-c', 'import faster_whisper, ctranslate2; print(ctranslate2.__version__)'], { env });
      if (check.code !== 0 || !check.tail.includes(pkgs.ctranslate2)) {
        throw new Error(`本机转录环境安装后自检失败：${check.tail.trim().slice(-300)}`);
      }
      writeFileSync(stampFile(home), JSON.stringify({ stamp: expectedStamp(gpu), gpu, at: new Date().toISOString() }, null, 2));
      return { gpu, note };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, { onWait: () => onState('installing', '另一个安装正在进行，等待其完成') });
}
