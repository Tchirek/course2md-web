//! 开发用的静态服务器，只服务于目视校验。
//!
//! 为什么需要它：Chrome 137 起彻底关掉了 `--load-extension` 这个开发开关，
//! 想把扩展页面装进 Chrome 截图已经不可行。而这些界面对 chrome.* 的依赖很浅
//! （存储、消息、getURL），用一层替身就足够把**视觉**验完整。
//!
//! 本文件只在开发时跑；它把 tools/chrome-mock.js 注入到响应的 HTML 里，
//! 产品文件本身一行都不改。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '');
    const file = join(ROOT, rel || 'tools/selftest.html');

    // 不许跳出仓库
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }

    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    if (type.startsWith('text/html')) {
      let html = await readFile(file, 'utf8');
      // 在页面自己的脚本之前插入 chrome 替身
      const tag = '<script src="/tools/chrome-mock.js"></script>';
      html = html.replace(/<head([^>]*)>/i, (m) => `${m}\n    ${tag}`);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(500).end(String(error?.message ?? error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`自测服务器： http://127.0.0.1:${PORT}/tools/selftest.html`);
});
