import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// B 站的主 CDN 偶尔无法连接；playurl 同时给出可用的备用线路。
export async function downloadBilibiliAudio(source, dir, signal, onProgress = () => {}) {
  return downloadBilibiliMedia(source, dir, signal, onProgress, 'audio');
}

export async function downloadBilibiliVideo(source, dir, signal, onProgress = () => {}) {
  return downloadBilibiliMedia(source, dir, signal, onProgress, 'video');
}

async function downloadBilibiliMedia(source, dir, signal, onProgress, type) {
  const bvid = source.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10})(?:\/|$)/)?.[1];
  if (!bvid) throw new Error('无法识别 B 站视频编号');
  const headers = { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' };
  const json = async (url) => {
    const reply = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
    if (!reply.ok) throw new Error(`B 站接口 HTTP ${reply.status}`);
    const body = await reply.json();
    if (body.code !== 0) throw new Error(`B 站接口：${body.message || body.code}`);
    return body.data;
  };
  const view = await json(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const part = Math.max(1, Number(source.searchParams.get('p')) || 1);
  const cid = part === 1 ? (view.pages?.[0]?.cid ?? view.cid) : view.pages?.[part - 1]?.cid;
  if (!cid) throw new Error('B 站未返回分集编号');
  const play = await json(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&qn=64`);
  const formats = play.dash?.[type] ?? [];
  const media = [...formats].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0];
  if (!media) throw new Error(`B 站未返回可下载${type === 'video' ? '画面' : '音轨'}`);
  const urls = [...(media.backupUrl ?? media.backup_url ?? []), media.baseUrl ?? media.base_url]
    .filter((url) => typeof url === 'string' && url.startsWith('https://'));
  const file = path.join(dir, `input.m4s`);
  for (const [index, url] of urls.entries()) {
    if (signal.aborted) throw new Error('已取消');
    onProgress(`正在尝试备用${type === 'video' ? '画面' : '音轨'}线路 ${index + 1}/${urls.length}`);
    try {
      const reply = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
      if (!reply.ok || !reply.body) throw new Error(`${type === 'video' ? '画面' : '音轨'} HTTP ${reply.status}`);
      await pipeline(Readable.fromWeb(reply.body), createWriteStream(file), { signal });
      return file;
    } catch (error) {
      await rm(file, { force: true });
      if (signal.aborted) throw error;
    }
  }
  throw new Error(`B 站备用${type === 'video' ? '画面' : '音轨'}线路均不可用`);
}
