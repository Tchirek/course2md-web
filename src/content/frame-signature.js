//! 画面的灰度签名：把取到的 JPEG 缩到 160 宽的灰度图，供 core/similarity.js 比较。

import { SIGNATURE_WIDTH, signatureHeight } from '../core/similarity.js';

/**
 * @param {string} dataUrl `data:image/jpeg;base64,…`（本机助手取回的画面）
 * @returns {Promise<import('../core/similarity.js').Signature>}
 */
export async function signatureOf(dataUrl) {
  // 直接解 base64，不走 fetch：页面的 CSP 可能不许 fetch data: 地址
  const [head, body = ''] = String(dataUrl).split(',', 2);
  const type = head.match(/^data:([^;,]+)/)?.[1] ?? 'image/jpeg';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  const width = SIGNATURE_WIDTH;
  const height = signatureHeight(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(width, height);
  const context = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const rgba = context.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114);
  }
  return { width, height, data };
}
