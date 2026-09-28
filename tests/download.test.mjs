import test from 'node:test';
import assert from 'node:assert/strict';

const downloads = [];
globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} }, onInstalled: { addListener() {} } },
  downloads: { async download(args) { downloads.push(args); return downloads.length; } },
};
const { saveBundle } = await import('../src/background/sw.js');

test('图文下载先保存 frames，再保存引用这些帧的 course.md', async () => {
  const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
  const md = '![视频 00:10 的截图](frames/slide_0001.jpg)\n';
  const result = await saveBundle({ folder: '课/第一讲', markdown: md, images: [jpeg] });
  assert.equal(result.images, 1);
  assert.match(downloads[0].filename, /^课 第一讲-[a-z0-9]+\/frames\/slide_0001\.jpg$/);
  assert.equal(downloads[1].filename, `${result.folder}/course.md`);
  assert.equal(Buffer.from(downloads[1].url.split(',')[1], 'base64').toString(), md);
});
