// README 用の実演素材（GIF と画面写真）を、本物の拡張を本物の YouTube 上で動かして撮る。
// 合成画像は使わない：見せているページの中身はすべてその場で生成された結果。
//
//   npm run media                 すべて撮る → docs/media/
//   npm run media -- deferred     名前に "deferred" を含む場面だけ
//   C2MD_MEDIA_KEEP=1 npm run media   合成したコマを消さずに残す
//
// 要るもの：Edge、ffmpeg、ネットワーク、MizoreLink（截图を取るため。npm run local:install）。
//
// 仕上げは録画ソフトと同じ考え方：
// - 画面は CDP の screencast で記録する（変化したときだけ一枚届く）。待ち時間は早送りにする。
// - 光標は画面記録に写らない。本物のマウス操作の位置と時刻を記録し、合成時に出力の一コマごとに
//   補間して描く。録画のコマ数に左右されず、動きは常に滑らか。押した瞬間は光標が少し縮む。
// - 要所で素早く寄って引く（カメラ）。寄り引きは出力時間で一定の長さ（早送り中でも速すぎない）。
// - 合成はブラウザの canvas で行う（画素以下の精度で拡大縮小でき、寄り引きがぶれない）。
//   出力は 50 fps（GIF で安定して再生できる上限）。
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
const FPS = 50;
/** 寄り引きの長さ（出力の秒） */
const CAMERA_SECONDS = 0.38;
/** 早送り区間で一コマを見せる最長（出力の秒） */
const FAST_FRAME_CAP = 0.12;
/** 今の光標の位置（glideTo の起点） */
let mouse = { x: WIDTH * 0.45, y: HEIGHT * 0.62 };
/** 記録中の場面。マウス操作はここに書き留める */
let active = null;

if (!EDGE) {
  console.error('Edge が見つからない。');
  process.exit(1);
}
if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.error('ffmpeg が見つからない。');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now() / 1000;
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
  const full = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const rec = await record(page, full);
  await sleep(350);
  const arrow = await launcherCenter(page);
  // 標題の ↗ に寄りながら光標を運ぶ
  rec.camera(zoomAt(arrow, 2.1, full));
  await glideTo(page, arrow, 560);
  await sleep(180);
  await click(page);
  await sleep(160);
  rec.camera(full);
  await waitPanel(page, (s) => s.says >= 4, 30_000);
  // 文字が出たら浮窓の上半分（見出し・切り替え・最初の段落）へ寄る
  const panel = await panelBox(page);
  rec.camera(zoomAt({ x: panel.x + panel.width / 2, y: panel.y + panel.height * 0.42 }, 1.6, full));
  await sleep(1300);
  rec.speed(10);
  await waitPanel(page, (s) => s.images >= 3 && s.exportReady, 240_000);
  rec.speed(1);
  await sleep(300);
  await wheel(page, 170, 520);
  await sleep(1100);
  rec.camera(full);
  await sleep(700);
  const launch = await rec.stop();
  if (wanted('launch')) await makeGif(launch, 'demo-launch.gif', 880, 128);

  if (wanted('density')) {
    // 前の場面で読み進めた分を戻し、截图が一枚まるごと見える位置から始める
    await page.evaluate(() => {
      const body = document.getElementById('c2md-panel-host')?.shadowRoot?.querySelector('.c2md-panel-body');
      if (body) body.scrollTop = 0;
    });
    const base = pad(await panelBox(page), 6);
    const dens = await record(page, base);
    await sleep(350);
    let first = true;
    for (const level of ['少', '多', '无', '默认']) {
      const target = await panelCenter(page, 'text', level);
      // 最初の一回だけ切り替えの帯に寄って場所を示し、あとは全体で変化を見せる
      if (first) dens.camera(zoomAt(target, 1.7, base));
      await glideTo(page, target, first ? 480 : 380);
      await sleep(120);
      await click(page);
      if (first) {
        await sleep(220);
        dens.camera(base);
        first = false;
      }
      await waitPanel(page, (s) => s.exportReady, 60_000);
      await sleep(950);
    }
    await makeGif(await dens.stop(), 'demo-density.gif', 560);
  }

  if (wanted('light')) {
    await dock(page);
    await page.mouse.move(WIDTH / 3, HEIGHT - 40);
    await sleep(1200);
    await page.screenshot({ path: join(OUT, 'panel-light.png') });
  }
  await page.close();
}

/** 生成中に「复制」「下载」を先に押しておくと、できた瞬間に実行される。 */
async function deferredExport() {
  const page = await openLecture(LECTURE_2, 240);
  await glideTo(page, await launcherCenter(page), 1);
  await click(page);
  await waitPanel(page, (s) => s.says >= 1, 30_000);
  // 截图が多い档位にして、書き出しが「完了後」になる待ち時間を確保する（撮り終えたら戻す）
  await glideTo(page, await panelCenter(page, 'text', '多'), 1);
  await click(page);
  const base = pad(await panelBox(page), 6);
  mouse = { x: base.x + base.width / 2, y: base.y + base.height / 2 };
  await page.mouse.move(mouse.x, mouse.y);
  const rec = await record(page, base);
  await sleep(250);
  // この場面は寄り引きなし：パネル全体を映したまま、ボタンの変化と中身の生成を同時に見せる
  const copy = await panelCenter(page, 'label', '复制 Markdown');
  const save = await panelCenter(page, 'label', '下载图文 .md');
  await glideTo(page, copy, 480);
  await sleep(120);
  await click(page);
  // 先に押せたこと（「完成后复制」の予約）を確かめる。もうできていたなら実演にならない
  await waitPanel(page, (s) => s.armed, 1500).catch(() => {
    throw new Error('押した時点で生成が終わっていて、「完了後に実行」を実演できなかった。もう一度撮り直す。');
  });
  await sleep(450);
  await glideTo(page, save, 380);
  await sleep(140);
  await click(page);
  await sleep(700);
  rec.speed(12);
  // 複製はその場で終わるが、図文の保存は画像を一枚ずつ書くぶん遅れて「已保存」になる
  await waitPanel(page, (s) => s.copied || s.saved, 240_000);
  rec.speed(1);
  await waitPanel(page, (s) => s.saved, 60_000);
  // 「已保存」は 1.8 秒で消えるので、その前に止める（最後のコマは長めに見せる）
  await sleep(700);
  const clip = await rec.stop();
  await glideTo(page, await panelCenter(page, 'text', '默认'), 1);
  await click(page);
  await makeGif(clip, 'demo-deferred.gif', 560);
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
  await page.screenshot({ path: join(OUT, 'panel-dark.png') });
  await page.close();
}

// ---------- ページの準備 ----------

async function openLecture(url, at) {
  const page = await browser.newPage();
  await prepare(page, url, at);
  return page;
}

/** 動画を開いて広告を待ち、見栄えのする場面で止め、光標を置く。 */
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
  // 光標は標題の下、説明欄から。動画の上だと再生の操作バー、チャンネル名の上だと吹き出しが出てしまう
  const launcher = await launcherCenter(page);
  mouse = { x: Math.max(40, launcher.x - 200), y: Math.min(HEIGHT - 20, launcher.y + 150) };
  await page.mouse.move(mouse.x, mouse.y);
  await sleep(2500);
}

// ---------- 操作（記録中なら光標の位置と押した時刻を書き留める） ----------

/** 素早く動かし、終わりはゆるやかに止める（ease-out）。 */
async function glideTo(page, to, ms) {
  const from = { ...mouse };
  const started = Date.now();
  for (;;) {
    const k = Math.min(1, (Date.now() - started) / Math.max(1, ms));
    const e = 1 - (1 - k) ** 3;
    const point = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    await page.mouse.move(point.x, point.y);
    active?.pointer(point);
    if (k >= 1) break;
    await sleep(8);
  }
  mouse = { ...to };
}

async function click(page) {
  active?.press(mouse);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
}

/** パネル本文の上でホイールを細かく回す（なめらかに読み進める）。 */
async function wheel(page, total, ms) {
  const box = await panelBox(page);
  await glideTo(page, { x: box.x + box.width / 2, y: box.y + box.height * 0.6 }, 320);
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: total / steps });
    await sleep(16);
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

/** 画面（base）と同じ縦横比で、point を中心に factor 倍に寄った範囲。base からははみ出さない。 */
function zoomAt(point, factor, base) {
  const width = base.width / factor;
  const height = base.height / factor;
  return {
    x: Math.min(Math.max(point.x - width / 2, base.x), base.x + base.width - width),
    y: Math.min(Math.max(point.y - height / 2, base.y), base.y + base.height - height),
    width,
    height,
  };
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
        armed: buttons.some((b) => b.getAttribute('aria-pressed') === 'true'),
        text: root?.querySelector('.c2md-panel-status')?.textContent?.trim().slice(0, 200) ?? '(パネルなし)',
      };
    }).catch(() => null);
    if (state && test(state)) return state;
    await sleep(100);
  }
  const shot = join(tmpdir(), 'c2md-media-failed.png');
  await page.screenshot({ path: shot }).catch(() => {});
  throw new Error(`パネルが期待した状態にならない：${JSON.stringify(state)}（画面：${shot}）`);
}

// ---------- 記録 ----------

/**
 * 場面の記録を始める。base はその場面で見せる範囲（CSS 画素）。
 * speed(n)：以降を n 倍の早送りに。camera(rect)：今から rect へ寄る（引く）。
 */
async function record(page, base) {
  const cdp = await page.createCDPSession();
  const clip = { base, frames: [], speeds: [{ t: now(), speed: 1 }], cameras: [], pointer: [], presses: [], end: 0 };
  // コマの時刻は描画の時刻。受け取った時刻との差の最小を時計のずれとみなし、手元の時計にそろえる
  let skew = Infinity;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    skew = Math.min(skew, now() - metadata.timestamp);
    clip.frames.push({ data, stamp: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  // 既定では CSS 画素の大きさで届く。装置画素の大きさを上限に指定して、細部まで写す
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 92, everyNthFrame: 1,
    maxWidth: Math.round(WIDTH * SCALE), maxHeight: Math.round(HEIGHT * SCALE),
  });
  const handle = {
    speed(n) { clip.speeds.push({ t: now(), speed: n }); },
    camera(rect) { clip.cameras.push({ t: now(), rect }); },
    pointer(point) { clip.pointer.push({ t: now(), ...point }); },
    press(point) { clip.presses.push({ t: now(), ...point }); },
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      active = null;
      clip.end = now();
      for (const frame of clip.frames) frame.t = frame.stamp + (Number.isFinite(skew) ? skew : 0);
      return clip;
    },
  };
  active = handle;
  handle.pointer(mouse);
  return handle;
}

// ---------- 合成 ----------

/**
 * 記録の時刻（秒）を出力の時刻へ写す関数を作る。等速区間はそのまま、早送り区間は
 * 速さで割り、さらに一コマの表示を FAST_FRAME_CAP までに詰める（止まっている間を飛ばす）。
 */
function timeWarp(clip) {
  const start = clip.speeds[0].t;
  const speedAt = (t) => clip.speeds.filter((s) => s.t <= t).at(-1)?.speed ?? 1;
  // 区切り：各コマの時刻と速さの切り替え時刻
  const cuts = [...new Set([start, clip.end, ...clip.frames.map((f) => f.t), ...clip.speeds.map((s) => s.t)])]
    .filter((t) => t >= start && t <= clip.end).sort((a, b) => a - b);
  const points = [{ src: start, out: 0 }];
  for (let i = 1; i < cuts.length; i++) {
    const raw = cuts[i] - cuts[i - 1];
    const speed = speedAt(cuts[i - 1]);
    const shown = speed > 1 ? Math.min(raw / speed, FAST_FRAME_CAP) : raw;
    points.push({ src: cuts[i], out: points.at(-1).out + shown });
  }
  const toOut = (t) => {
    if (t <= points[0].src) return 0;
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i].src) {
        const a = points[i - 1];
        const b = points[i];
        return a.out + (b.out - a.out) * ((t - a.src) / Math.max(1e-9, b.src - a.src));
      }
    }
    return points.at(-1).out;
  };
  const toSrc = (o) => {
    for (let i = 1; i < points.length; i++) {
      if (o <= points[i].out) {
        const a = points[i - 1];
        const b = points[i];
        return a.src + (b.src - a.src) * ((o - a.out) / Math.max(1e-9, b.out - a.out));
      }
    }
    return points.at(-1).src;
  };
  return { toOut, toSrc, duration: points.at(-1).out };
}

// 場面は上の方のトップレベル await から呼ばれるので、ここは巻き上げの効く function 宣言にする
function easeInOut(k) {
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
}

function mix(a, b, k) {
  return {
    x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k,
    width: a.width + (b.width - a.width) * k, height: a.height + (b.height - a.height) * k,
  };
}

/** 出力時刻 o のカメラの範囲。寄り引きは始まりから CAMERA_SECONDS かけて移る。 */
function cameraAt(clip, warp, o) {
  let settled = clip.base;
  let from = clip.base;
  let to = clip.base;
  let startedAt = -Infinity;
  for (const move of clip.cameras) {
    const at = warp.toOut(move.t);
    if (at > o) break;
    // 前の移動の途中から次へ移れるよう、その時点の位置を起点にする
    settled = mix(from, to, easeInOut(Math.min(1, (at - startedAt) / CAMERA_SECONDS)));
    from = settled;
    to = move.rect;
    startedAt = at;
  }
  return mix(from, to, easeInOut(Math.min(1, (o - startedAt) / CAMERA_SECONDS)));
}

/** 記録の時刻 t の光標の位置（前後の記録点を直線で補う）。 */
function pointerAt(clip, t) {
  const list = clip.pointer;
  if (t <= list[0].t) return list[0];
  for (let i = 1; i < list.length; i++) {
    if (t <= list[i].t) {
      const k = (t - list[i - 1].t) / Math.max(1e-9, list[i].t - list[i - 1].t);
      return { x: list[i - 1].x + (list[i].x - list[i - 1].x) * k, y: list[i - 1].y + (list[i].y - list[i - 1].y) * k };
    }
  }
  return list.at(-1);
}

/**
 * 記録を 50 fps の GIF に仕上げる。最後の状態は少し長めに見せる。
 * colors：パレットの色数。パネルだけの画面は 64 で足りるが、ページ全体を写すと YouTube の赤と白に
 * 色を取られ、講義スライドの写真（金色）が桃色に崩れるので 128 にする。
 */
async function makeGif(clip, name, width, colors = 64) {
  const warp = timeWarp(clip);
  const height = Math.round((width * clip.base.height) / clip.base.width / 2) * 2;
  const hold = 1.2;
  const total = Math.ceil((warp.duration + hold) * FPS);
  const dir = mkdtempSync(join(tmpdir(), 'c2md-gif-'));
  // 描画用のページ。コマは data URL で渡す（file: の画像を canvas に描くと書き出しが禁じられる）
  const painter = await browser.newPage();
  await painter.setContent('<canvas></canvas>');
  await painter.evaluate((w, h) => {
    const canvas = document.querySelector('canvas');
    canvas.width = w;
    canvas.height = h;
    window.paint = async (job) => {
      const ctx = canvas.getContext('2d');
      if (job.frame) {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${job.frame}`;
        await img.decode();
        window.current = img;
      }
      const img = window.current;
      const k = img.naturalWidth / job.cssWidth;
      const cam = job.camera;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, cam.x * k, cam.y * k, cam.width * k, cam.height * k, 0, 0, w, h);
      // CSS 画素 → 出力画素
      const zoom = w / cam.width;
      const place = (p) => ({ x: (p.x - cam.x) * zoom, y: (p.y - cam.y) * zoom });
      const tip = place(job.pointer);
      // 光標は寄るにつれて少し大きく（等倍には追従させない）。押した瞬間は少し縮む
      const size = (Math.pow(zoom, 0.55) * job.press * w) / 1000;
      ctx.save();
      ctx.translate(tip.x, tip.y);
      ctx.scale(size * 1.15, size * 1.15);
      ctx.translate(-3, -2);
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 1;
      const arrow = new Path2D('M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.7 L16.6 12.4 Z');
      ctx.fillStyle = '#fff';
      ctx.fill(arrow);
      ctx.shadowColor = 'transparent';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#111';
      ctx.stroke(arrow);
      ctx.restore();
      return canvas.toDataURL('image/jpeg', 0.93).slice('data:image/jpeg;base64,'.length);
    };
  }, width, height);

  let shownIndex = -1;
  for (let n = 0; n < total; n++) {
    const o = Math.min(n / FPS, warp.duration);
    const t = warp.toSrc(o);
    let index = 0;
    while (index + 1 < clip.frames.length && clip.frames[index + 1].t <= t) index++;
    const pressed = clip.presses.some((p) => { const d = o - warp.toOut(p.t); return d >= 0 && d < 0.12; });
    const job = {
      frame: index !== shownIndex ? clip.frames[index].data : null,
      cssWidth: WIDTH,
      camera: cameraAt(clip, warp, o),
      pointer: pointerAt(clip, t),
      press: pressed ? 0.88 : 1,
    };
    shownIndex = index;
    const jpeg = await painter.evaluate((job) => window.paint(job), job);
    writeFileSync(join(dir, `o${String(n).padStart(5, '0')}.jpg`), Buffer.from(jpeg, 'base64'));
  }
  await painter.close();

  // 画面の大半は平らな色の UI。色数を絞り、ディザもかけない方が寄り引きのコマが軽い（抖動は模様になって圧縮を損なう）
  const filter = `split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  const out = join(OUT, name);
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'o%05d.jpg'),
    '-filter_complex', filter, '-loop', '0', out]);
  // C2MD_MEDIA_KEEP=1 なら合成したコマを残す（GIF の色数などを後から試すため）
  if (process.env.C2MD_MEDIA_KEEP) console.log(`合成したコマ：${dir}`);
  else rmSync(dir, { recursive: true, force: true });
  if (run.status !== 0) throw new Error(`ffmpeg が失敗：${run.stderr}`);
  console.log(`${name}  ${(total / FPS).toFixed(1)} s  ${FPS} fps  ${(statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
}
