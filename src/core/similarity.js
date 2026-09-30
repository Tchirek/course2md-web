//! 画面相似度：只保留有变化的画面。
// 与 course2md 的 scene.rs 同一判定：和上一张保留下来的画面做 SSIM，
// 低于 0.85 才算新画面（config.rs::DEFAULT_SIMILARITY）。
// 纯逻辑，不碰 DOM：画面的灰度签名由 content/frame-signature.js 在浏览器里算。

/** 相似度阈值：不低于它就视为同一画面（原版默认值）。 */
export const SIMILARITY = 0.85;
/** 签名的宽度（像素）。高度按画面比例取 8 的倍数，窗口正好铺满。 */
export const SIGNATURE_WIDTH = 160;

const WINDOW = 8;
// SSIM 的稳定常数：(0.01·255)² 与 (0.03·255)²
const C1 = 6.5025;
const C2 = 58.5225;

/**
 * @typedef {{width:number, height:number, data:Uint8Array|Uint8ClampedArray}} Signature 灰度图
 */

/**
 * 签名的高度：按画面比例，取 8 的倍数（至少 8）。
 * @param {number} width 原画面宽
 * @param {number} height 原画面高
 */
export function signatureHeight(width, height) {
  if (!(width > 0 && height > 0)) return WINDOW;
  return Math.max(WINDOW, Math.round((SIGNATURE_WIDTH * height) / width / WINDOW) * WINDOW);
}

/**
 * 两张灰度图的平均 SSIM（8×8 不重叠窗口）。尺寸不同就是不同的画面。
 * @param {Signature} a
 * @param {Signature} b
 * @returns {number} 0–1，越大越像
 */
export function ssim(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 0;
  const { width, height } = a;
  const n = WINDOW * WINDOW;
  let total = 0;
  let windows = 0;
  for (let y = 0; y + WINDOW <= height; y += WINDOW) {
    for (let x = 0; x + WINDOW <= width; x += WINDOW) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let j = 0; j < WINDOW; j++) {
        const row = (y + j) * width + x;
        for (let i = 0; i < WINDOW; i++) {
          const p = a.data[row + i];
          const q = b.data[row + i];
          sa += p;
          sb += q;
          saa += p * p;
          sbb += q * q;
          sab += p * q;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  }
  return windows ? total / windows : 0;
}

/**
 * 回看窗口（秒）：与这段时间内保留过的任何一张相似，也算重复。
 * 课堂录像常在幻灯片与讲师镜头之间来回切，只和上一张比（原版的做法），同一页会在每次
 * 切回来时再出现一次。实测 MIT 6.0001 第 2 讲（43 分钟，每 10 秒一个候选，共 261 个）：
 * 只比上一张留 188 张，其中幻灯片 61 张；回看 120 秒留 170 张、幻灯片 44 张；回看全程
 * 也只到 41 张。隔了两分钟以上又回到的那一页照常再给一张，读到那里时图就在眼前。
 */
export const REPEAT_WINDOW_SECS = 120;

/**
 * 去掉重复的画面：与上一张保留的，或回看窗口内保留过的任何一张相似，就略去。
 * 各分节内比较；每节的第一张总保留，章节开头有图可看。
 * 还没取到图的帧原样留着（它们仍在等待），不参与比较；有图但还没有签名的帧也留着，
 * 并且不作比较基准——宁可多一张，不误删。
 * @template {{t:number, image?:string}} F
 * @template {{frames:F[]}} S
 * @param {S[]} sections
 * @param {Map<number, Signature>} signatures 按帧时刻
 * @returns {S[]}
 */
export function keepChanged(sections, signatures) {
  return sections.map((section) => {
    /** @type {{t:number, signature:Signature|null}[]} */
    const kept = [];
    const frames = section.frames.filter((frame) => {
      if (!frame.image) return true;
      const signature = signatures.get(frame.t) ?? null;
      const repeated = signature && kept.some((earlier, i) =>
        earlier.signature && (i === kept.length - 1 || frame.t - earlier.t <= REPEAT_WINDOW_SECS) &&
        ssim(earlier.signature, signature) >= SIMILARITY);
      if (repeated) return false;
      kept.push({ t: frame.t, signature });
      return true;
    });
    return frames.length === section.frames.length ? section : { ...section, frames };
  });
}
