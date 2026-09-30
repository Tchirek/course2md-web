// README 用の実演素材（GIF と画面写真）を、本物の拡張を本物の YouTube 上で動かして撮る。
// 合成画像は使わない：見せているものはすべてその場で生成された結果。
//
//   npm run media                 すべて撮る → docs/media/
//   npm run media -- deferred     名前に "deferred" を含む場面だけ
//
// 要るもの：Edge、ffmpeg、ネットワーク、本機助手（截图を取るため。npm run local:install）。
// 画面の記録は CDP の screencast：画面が変わったときだけ一枚届くので、待ち時間は
// 各コマの表示時間を縮めて早送りにする（中身は間引かない）。
// 実演に使う講義は MIT OpenCourseWare 6.0001（CC BY-NC-SA 4.0）。
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'media');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
].find((p) => existsSync(p));
const LECTURE_1 = 'https://www.youtube.com/watch?v=nykOeWgQcHM';
const LECTURE_2 = 'https://www.youtube.com/watch?v=0jljZRnHwOI';
// CSS の画面は小さめにして画素比を上げる：縮小して載せても文字が読める大きさで写る
const WIDTH = 1100;
const HEIGHT = 700;
const SCALE = 1.25;
const PORT = 9360;
/** 今の光標の位置（glideTo の起点） */
let mouse = { x: WIDTH * 0.45, y: HEIGHT * 0.62 };

if (!EDGE) {
  console.error('Edge が見つからない。');
  process.exit(1);
}
if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.error('ffmpeg が見つからない。');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const only = process.argv[2]?.toLowerCase();
const wanted = (name) => !only || name.includes(only);
mkdirSync(OUT, { recursive: true });

// 拡張の読み込みには --load-extension が要る（Chrome 137 以降は使えないので Edge を使う）
const profile = mkdtempSync(join(tmpdir(), 'c2md-media-'));
const downloads = mkdtempSync(join(tmpdir(), 'c2md-media-dl-'));
mkdirSync(join(profile, 'Default'));
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false },
}));
const edge = spawn(EDGE, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--lang=en-US',
  '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled', `--window-size=${Math.round(WIDTH * SCALE) + 40},${Math.round(HEIGHT * SCALE) + 160}`,
  `--load-extension=${ROOT}`, 'about:blank',
], { stdio: 'ignore' });
let browser;
for (let i = 0; i < 30 && !browser; i++) {
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }).catch(() => null);
  if (!browser) await sleep(1000);
}

try {
  if (wanted('launch') || wanted('density') || wanted('light')) await lectureOne();
  if (wanted('deferred')) await deferredExport();
  if (wanted('dark')) await darkScreenshot();
} finally {
  await browser?.close().catch(() => {});
  const exited = new Promise((resolve) => edge.once('exit', resolve));
  edge.kill();
  await Promise.race([exited, sleep(5000)]);
  // Edge の子プロセスが遅れて手放すことがある。消せなくても結果には関わらない
  for (const dir of [profile, downloads]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* 一時フォルダに残るだけ */ }
  }
}

// ---------- 場面 ----------

/** 標題の ↗ で生成 → 截图がそろう → 档位の切り替え → 側栏に寄せて一枚。 */
async function lectureOne() {
  const page = await openLecture(LECTURE_1, 180);
  const rec = await record(page);
  await sleep(900);
  await glideTo(page, await launcherCenter(page), 900);
  await sleep(500);
  await click(page);
  await waitPanel(page, (s) => s.says >= 4, 30_000);
  await sleep(1800);
  rec.speed(10);
  await waitPanel(page, (s) => s.images >= 3 && s.exportReady, 240_000);
  rec.speed(1);
  await sleep(600);
  await wheel(page, 150, 900);
  await sleep(2000);
  const launch = await rec.stop();
  if (wanted('launch')) await makeGif(launch, 'demo-launch.gif', { width: 960 });

  if (wanted('density')) {
    // 前の場面で読み進めた分を戻し、截图が一枚まるごと見える位置から始める
    await page.evaluate(() => {
      const body = document.getElementById('c2md-panel-host')?.shadowRoot?.querySelector('.c2md-panel-body');
      if (body) body.scrollTop = 0;
    });
    const box = await panelBox(page);
    const dens = await record(page);
    await sleep(700);
    for (const level of ['少', '多', '无', '默认']) {
      await glideTo(page, await panelCenter(page, 'text', level), 600);
      await sleep(250);
      await click(page);
      await waitPanel(page, (s) => s.exportReady, 60_000);
      await sleep(1300);
    }
    await makeGif(await dens.stop(), 'demo-density.gif', { crop: pad(box, 6), width: 560 });
  }

  if (wanted('light')) {
    await dock(page);
    await page.mouse.move(WIDTH / 3, HEIGHT - 40);
    await sleep(1200);
    await hideCursor(page);
    await page.screenshot({ path: join(OUT, 'panel-light.png') });
  }
  await page.close();
}

/** 生成中に「复制」「下载」を先に押しておくと、できた瞬間に実行される。 */
async function deferredExport() {
  const page = await openLecture(LECTURE_2, 240);
  await glideTo(page, await launcherCenter(page), 1);
  await click(page);
  await waitPanel(page, (s) => s.says >= 3, 30_000);
  const box = await panelBox(page);
  mouse = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(mouse.x, mouse.y);
  const rec = await record(page);
  await sleep(800);
  await glideTo(page, await panelCenter(page, 'label', '复制 Markdown'), 700);
  await sleep(300);
  await click(page);
  await sleep(900);
  await glideTo(page, await panelCenter(page, 'label', '下载图文 .md'), 600);
  await sleep(300);
  await click(page);
  await sleep(1500);
  rec.speed(12);
  // 複製はその場で終わるが、図文の保存は画像を一枚ずつ書くぶん遅れて「已保存」になる
  await waitPanel(page, (s) => s.copied || s.saved, 240_000);
  rec.speed(1);
  await waitPanel(page, (s) => s.saved, 60_000);
  // 「已保存」は 1.8 秒で消える。消える前に止め、最後のコマ（長めに見せる）をこの状態にする
  await sleep(700);
  await makeGif(await rec.stop(), 'demo-deferred.gif', { crop: pad(box, 6), width: 560 });
  // 「已保存」はダウンロードの受け付けで出る。書き終わるまで少し待つ
  let saved = [];
  for (let i = 0; i < 30 && !saved.length; i++) {
    saved = readdirSync(downloads, { recursive: true }).map(String).filter((f) => f.endsWith('course.md'));
    if (!saved.length) await sleep(500);
  }
  if (saved[0]) {
    writeFileSync(join(tmpdir(), 'c2md-media-course.md'), readFileSync(join(downloads, saved[0])));
    console.log(`保存された course.md の写し：${join(tmpdir(), 'c2md-media-course.md')}`);
  }
  await page.close();
}

/** 暗い配色の画面写真（YouTube もパネルも OS の配色に従う）。 */
async function darkScreenshot() {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await prepare(page, LECTURE_1, 180);
  await glideTo(page, await launcherCenter(page), 1);
  await click(page);
  await waitPanel(page, (s) => s.images >= 3 && s.exportReady, 240_000);
  await dock(page);
  await page.mouse.move(WIDTH / 3, HEIGHT - 40);
  await sleep(1200);
  await hideCursor(page);
  await page.screenshot({ path: join(OUT, 'panel-dark.png') });
  await page.close();
}

// ---------- ページの準備 ----------

async function openLecture(url, at) {
  const page = await browser.newPage();
  await prepare(page, url, at);
  return page;
}

/** 動画を開いて広告を待ち、見栄えのする場面で止め、見える位置に光標を置く。 */
async function prepare(page, url, at) {
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.bringToFront();
  for (let i = 0; i < 120; i++) {
    const ad = await page.evaluate(() => {
      /** @type {HTMLElement|null} */ (document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern'))?.click();
      return Boolean(document.querySelector('.ad-showing')) || !document.querySelector('ytd-watch-metadata');
    }).catch(() => true); // 読み込み直しの途中なら、落ち着くまで待つ
    if (!ad && i >= 6) break;
    await sleep(1000);
  }
  await page.evaluate((at) => {
    const video = document.querySelector('video');
    if (video) {
      video.currentTime = at;
      video.pause();
    }
    scrollTo(0, 0);
    // おすすめ欄は実演と無関係な他人の動画がその時々で並ぶので、写さない（どのみちパネルの下になる）
    const style = document.createElement('style');
    style.textContent = '#secondary, #related, ytd-comments { visibility: hidden !important; }';
    document.head.appendChild(style);
  }, at);
  await installCursor(page);
  // 光標は標題の左下から。動画の上に置くと再生の操作バーが出てしまう
  const launcher = await launcherCenter(page);
  mouse = { x: Math.max(40, launcher.x - 240), y: Math.min(HEIGHT - 20, launcher.y + 70) };
  await page.mouse.move(mouse.x, mouse.y);
  await sleep(2500);
}

/** 光標は画面記録に写らないので、本物のマウス事件を追う印を重ねる（押すと波紋）。 */
async function installCursor(page) {
  await page.evaluate(() => {
    const dot = document.createElement('div');
    dot.id = 'c2md-demo-cursor';
    // YouTube は Trusted Types を課すので innerHTML は使えない。要素を組み立てる
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ width: '22', height: '22', viewBox: '0 0 22 22' })) svg.setAttribute(k, v);
    const path = document.createElementNS(ns, 'path');
    for (const [k, v] of Object.entries({ d: 'M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.7 L16.6 12.4 Z', fill: '#fff', stroke: '#111', 'stroke-width': '1.4', 'stroke-linejoin': 'round' })) path.setAttribute(k, v);
    svg.appendChild(path);
    dot.appendChild(svg);
    dot.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))';
    document.documentElement.appendChild(dot);
    const style = document.createElement('style');
    style.textContent = '@keyframes c2md-demo-ripple{from{opacity:.55;transform:translate(-50%,-50%) scale(.3)}to{opacity:0;transform:translate(-50%,-50%) scale(1)}}';
    document.head.appendChild(style);
    addEventListener('mousemove', (e) => { dot.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', (e) => {
      const ring = document.createElement('div');
      ring.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:44px;height:44px;border-radius:50%;background:rgba(36,106,80,.45);z-index:2147483646;pointer-events:none;animation:c2md-demo-ripple .5s ease-out forwards`;
      document.documentElement.appendChild(ring);
      setTimeout(() => ring.remove(), 600);
    }, true);
  });
}

async function hideCursor(page) {
  await page.evaluate(() => document.getElementById('c2md-demo-cursor')?.remove());
}

// ---------- 操作 ----------

/** なめらかに動かす（ease-in-out）。 */
async function glideTo(page, to, ms) {
  const steps = Math.max(1, Math.round(ms / 16));
  const from = { ...mouse };
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    if (steps > 1) await sleep(16);
  }
  mouse = { ...to };
}

async function click(page) {
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}

/** パネル本文の上でホイールを回す（読み進める様子）。 */
async function wheel(page, total, ms) {
  const box = await panelBox(page);
  await glideTo(page, { x: box.x + box.width / 2, y: box.y + box.height * 0.6 }, 500);
  const steps = Math.max(1, Math.round(ms / 50));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: total / steps });
    await sleep(50);
  }
}

/** 見出しをつかんで画面の右端まで運び、全高の側栏に吸着させる。 */
async function dock(page) {
  const head = await panelCenter(page, 'head');
  await glideTo(page, head, 400);
  await page.mouse.down();
  await glideTo(page, { x: WIDTH - 4, y: head.y }, 700);
  await page.mouse.up();
  await sleep(800);
}

// ---------- パネルの様子 ----------

async function launcherCenter(page) {
  for (let i = 0; i < 40; i++) {
    const point = await page.evaluate(() => {
      const host = document.querySelector('[data-c2md-launcher]');
      const r = host?.shadowRoot?.querySelector('button')?.getBoundingClientRect();
      return r?.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    if (point) return point;
    await sleep(500);
  }
  throw new Error('標題の ↗ が見つからない');
}

/**
 * パネル（影の DOM の中）の要素の中心。YouTube の CSP は動的な評価を許さないので、
 * 探し方はここに決め打ちする：text＝文字が一致するボタン、label＝書き出しボタンの表示名、head＝見出しの余白。
 */
async function panelCenter(page, how, arg) {
  const point = await page.evaluate((how, arg) => {
    const root = document.getElementById('c2md-panel-host')?.shadowRoot;
    if (!root) return null;
    const buttons = [...root.querySelectorAll('button')];
    const node = how === 'text' ? buttons.find((b) => b.textContent?.trim() === arg)
      : how === 'label' ? buttons.find((b) => b.dataset.label === arg)
        : root.querySelector('.c2md-panel-head .c2md-source') ?? root.querySelector('.c2md-panel-head');
    const r = node?.getBoundingClientRect();
    return r?.width ? { x: r.x + (how === 'head' ? Math.min(40, r.width / 2) : r.width / 2), y: r.y + r.height / 2 } : null;
  }, how, arg);
  if (!point) throw new Error(`パネルの要素が見つからない：${how} ${arg ?? ''}`);
  return point;
}

async function panelBox(page) {
  return page.evaluate(() => {
    const r = document.getElementById('c2md-panel-host').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

function pad(box, px) {
  const x = Math.max(0, Math.floor(box.x - px));
  const y = Math.max(0, Math.floor(box.y - px));
  return { x, y, width: Math.min(WIDTH - x, Math.ceil(box.width + px * 2)), height: Math.min(HEIGHT - y, Math.ceil(box.height + px * 2)) };
}

/** パネルの状態が条件を満たすまで待つ。 */
async function waitPanel(page, test, timeout) {
  const started = Date.now();
  let state = null;
  while (Date.now() - started < timeout) {
    state = await page.evaluate(() => {
      const root = document.getElementById('c2md-panel-host')?.shadowRoot;
      const buttons = [...(root?.querySelectorAll('.c2md-panel-foot .c2md-button') ?? [])];
      const copy = /** @type {HTMLElement|undefined} */ (buttons[0]);
      return {
        says: root?.querySelectorAll('.c2md-say').length ?? 0,
        images: [...(root?.querySelectorAll('img') ?? [])].filter((img) => img.complete && img.naturalWidth).length,
        exportReady: Boolean(copy && !copy.hasAttribute('title') && !copy.hasAttribute('disabled')),
        copied: buttons.some((b) => b.dataset.label === '已复制'),
        saved: buttons.some((b) => b.dataset.label === '已保存'),
        text: root?.querySelector('.c2md-panel-status')?.textContent?.trim().slice(0, 200) ?? '(パネルなし)',
      };
    }).catch(() => null);
    if (state && test(state)) return state;
    await sleep(250);
  }
  const shot = join(tmpdir(), 'c2md-media-failed.png');
  await page.screenshot({ path: shot }).catch(() => {});
  throw new Error(`パネルが期待した状態にならない：${JSON.stringify(state)}（画面：${shot}）`);
}

// ---------- 記録と GIF ----------

/** screencast を始める。speed(n) 以降のコマは n 倍速で表示する。 */
async function record(page) {
  const cdp = await page.createCDPSession();
  const frames = [];
  let speed = 1;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp, speed });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  // 既定では CSS 画素の大きさで届く。装置画素の大きさを上限に指定して、細部まで写す
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 92, everyNthFrame: 1,
    maxWidth: Math.round(WIDTH * SCALE), maxHeight: Math.round(HEIGHT * SCALE),
  });
  return {
    speed(n) { speed = n; },
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      frames.push({ ...frames[frames.length - 1], t: Date.now() / 1000, speed });
      await cdp.detach().catch(() => {});
      return frames;
    },
  };
}

/** コマ列を GIF に。早送り区間は表示時間を縮め、最後のコマは少し長く見せる。 */
async function makeGif(frames, name, { crop, width }) {
  const dir = mkdtempSync(join(tmpdir(), 'c2md-gif-'));
  const lines = [];
  // ffmpeg 4.2 の concat は相対パスを一覧の場所から解決しないので、絶対パスで書く
  const at = (file) => `file '${join(dir, file).replaceAll('\\', '/')}'`;
  for (let i = 0; i < frames.length - 1; i++) {
    const file = `f${String(i).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, file), Buffer.from(frames[i].data, 'base64'));
    const raw = Math.max(0, frames[i + 1].t - frames[i].t);
    const shown = frames[i].speed > 1 ? Math.min(raw / frames[i].speed, 0.25) : raw;
    lines.push(at(file), `duration ${Math.max(shown, 0.001).toFixed(3)}`);
  }
  const last = `f${String(frames.length - 2).padStart(5, '0')}.jpg`;
  lines.push(at(last), 'duration 2.5', at(last));
  writeFileSync(join(dir, 'list.txt'), lines.join('\n'));
  // 切り抜きは CSS 画素で持っている。届いたコマの実際の幅から倍率を出して換算する
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', join(dir, 'f00000.jpg')]);
  const ratio = Number(probe.stdout.toString().trim()) / WIDTH || 1;
  const px = (v) => Math.round(v * ratio);
  const area = crop ? `crop=${px(crop.width)}:${px(crop.height)}:${px(crop.x)}:${px(crop.y)},` : '';
  const filter = `fps=15,${area}scale=${width}:-2:flags=lanczos,split[a][b];` +
    '[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  const out = join(OUT, name);
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
    '-filter_complex', filter, '-loop', '0', out]);
  rmSync(dir, { recursive: true, force: true });
  if (run.status !== 0) throw new Error(`ffmpeg が失敗：${run.stderr}`);
  console.log(`${name}  ${(statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
}
