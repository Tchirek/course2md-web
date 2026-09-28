//! 生成扩展图标（PNG）。
//!
//! 为什么自己画：MV3 的 action 图标不收 SVG，而一个 16px 的图标要么是按几何
//! 量出来的，要么是糊的。这里用 4×4 超采样自己栅格化，然后手写 PNG 编码——
//! 不引入 sharp/canvas 这类原生依赖，node tools/make-icons.mjs 就能跑。
//!
//! 图形语言与界面一致：墨色圆角方块 + 唯一的松绿强调色。小尺寸只留播放三角，
//! 大尺寸才加文字行——这是真实图标集的做法，不是把一张图缩小。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'src', 'ui', 'icons');

// 与 tokens.css 同源的颜色
const INK = [0x14, 0x15, 0x1a];
const PAPER = [0xf6, 0xf7, 0xfb];
const MARK = [0x24, 0x6a, 0x50];

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // 每轴 4 次采样 = 16 个子样本/像素

// ---------- 几何：全部在图标的 32 单位坐标系里定义 ----------

const UNIT = 32;
const PAD = 1;
const RADIUS = 7;

/** 圆角矩形内点测试。 */
function inRoundedRect(x, y) {
  const x0 = PAD;
  const y0 = PAD;
  const x1 = UNIT - PAD;
  const y1 = UNIT - PAD;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + RADIUS), x1 - RADIUS);
  const cy = Math.min(Math.max(y, y0 + RADIUS), y1 - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  // 圆角区外的点按到圆心的距离判定
  return dx * dx + dy * dy <= RADIUS * RADIUS + 1e-9 || (x >= x0 + RADIUS && x <= x1 - RADIUS) ||
    (y >= y0 + RADIUS && y <= y1 - RADIUS);
}

/** 三角形内点测试（同向叉积）。 */
function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** 带圆头的横线（胶囊），用于文字行。 */
function inCapsule(x, y, x0, x1, cy, halfThickness) {
  const cx = Math.min(Math.max(x, Math.min(x0, x1)), Math.max(x0, x1));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= halfThickness * halfThickness;
}

/**
 * 逐像素栅格化。
 * @param {number} size 输出边长
 * @param {(x:number,y:number)=>number[]|null} shade 返回 [r,g,b,a] 或 null（透明）
 */
function raster(size, shade) {
  // 用 clamped 而不是普通 Uint8Array：普通 Uint8Array 的赋值是**取模 256**
  // 而不是夹取，一个超范围的 alpha（255*255=65025）会悄悄变成 1，画面直接反相。
  const pixels = new Uint8ClampedArray(size * size * 4);
  const scale = UNIT / size;
  const total = SAMPLES * SAMPLES;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          const color = shade(x, y);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          a += color[3];
        }
      }
      const idx = (py * size + px) * 4;
      if (a > 0) {
        // 颜色按「已覆盖的子样本数」平均，避免边缘混入黑色；
        // alpha 直接取平均覆盖率，a 本身已经是 0-255 量纲。
        const covered = a / 255;
        pixels[idx] = r / covered;
        pixels[idx + 1] = g / covered;
        pixels[idx + 2] = b / covered;
        pixels[idx + 3] = a / total;
      }
    }
  }
  return pixels;
}

/** 小尺寸只留三角，大尺寸才有面积放文字行。 */
function shadeFor(size) {
  const detailed = size >= 40;

  // 大尺寸：三角上移，下面留出两行文字，行距足够不会糊成一块
  const smallTri = [[10.5, 7.2], [23.5, 13.9], [10.5, 20.6]];
  const ruleThickness = 1.05;
  // 小尺寸：三角占满，靠它自己说明这是什么
  const bigTri = [[10.5, 7.5], [24.5, 16], [10.5, 24.5]];

  return (x, y) => {
    if (!inRoundedRect(x, y)) return null;

    if (detailed) {
      if (inTriangle(x, y, ...smallTri)) return [...PAPER, 255];
      if (inCapsule(x, y, 10.5, 23.5, 24.4, ruleThickness)) return [...MARK, 255];
      if (inCapsule(x, y, 10.5, 18.5, 27.8, ruleThickness)) return [...MARK, 255];
      return [...INK, 255];
    }

    if (inTriangle(x, y, ...bigTri)) return [...PAPER, 255];
    return [...INK, 255];
  };
}

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** RGBA 像素 -> PNG。每行前置一个 0（filter: None）。 */
function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：真彩 + alpha
  ihdr[10] = 0; // 压缩：deflate
  ihdr[11] = 0; // 过滤：无
  ihdr[12] = 0; // 隔行：无

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 产出 ----------

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const pixels = raster(size, shadeFor(size));
  const png = encodePng(pixels, size);
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`icon-${size}.png  ${png.length} 字节`);
}
