import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildDoc, upstreamSnapshot, fromUpstream, toJson } from '../src/core/format.js';
import { markdownOf, imageBundle } from '../src/content/exporter.js';

test('原版适配保留章节、所有画面和 raw；段落只归属一次，跳过段只留网页原文', () => {
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '0.4.0' }) } };
  const sections = [{ title: '导论', t: 0, end: 30, frames: [
    { t: 0, image: 'data:image/jpeg;base64,/9j/AA==' },
    { t: 15, image: 'data:image/png;base64,iVBORw0KGgo=' },
  ], segments: [
    { start: 1, end: 4, text: '新文本', raw: '原文' },
    { start: 16, end: 20, text: '第二段' },
    { start: 21, end: 22, text: '', raw: '删掉的原文', state: 'skipped' },
  ] }];
  const doc = buildDoc({ title: '课', site: 'youtube', videoId: '123', cid: 12, duration: 30, url: 'https://www.youtube.com/watch?v=123' }, sections);
  assert.equal(doc.generator.version, '0.4.0');
  assert.equal(doc.meta.videoId, '123');
  assert.equal(JSON.parse(toJson(doc)).sections[0].frames.length, 2);
  const snapshot = upstreamSnapshot(doc, sections);
  assert.equal(snapshot.document.schema, 1);
  assert.deepEqual(snapshot.document.sections.map((s) => s.speech.length), [1, 1]);
  assert.equal(snapshot.document.sections[0].speech[0].raw, '原文');
  assert.equal(snapshot.web.sections[0].title, '导论');
  assert.equal(snapshot.web.sections[0].segments.length, 3);
  assert.equal(Object.keys(snapshot.images).length, 2);
  assert.match(snapshot.markdown, /frames\/slide_0002.png/);
  assert.equal(sections[0].frames[0].image.startsWith('data:'), true, '不修改面板画面');
  const restored = fromUpstream(snapshot.document);
  assert.equal(restored.meta.url, doc.meta.url);
  assert.equal(restored.sections.flatMap((s) => s.segments).length, 2);
  delete globalThis.chrome;
});

test('网页适配不将未经获取的远程图片写进课程库', () => {
  const sections = [{ t: 0, segments: [{ start: 0, end: 1, text: 'x' }], frames: [{ t: 0, image: 'https://evil/image' }] }];
  assert.throws(() => upstreamSnapshot(buildDoc({}, sections), sections), /本机画面/);
  assert.throws(() => fromUpstream({ schema: 2 }), /版本/);
});

test('章节边界重复引用同一时刻画面时，只保存一份资产', () => {
  const image = 'data:image/jpeg;base64,/9j/AA==';
  const sections = [0, 1].map((t) => ({ t, end: 2, segments: [{ start: t, end: t + 1, text: 'x' }], frames: [{ t: 1, image }] }));
  const snapshot = upstreamSnapshot(buildDoc({ duration: 2 }, sections), sections);
  assert.equal(Object.keys(snapshot.images).length, 1);
  assert.equal(snapshot.web.sections[0].frames[0].image, snapshot.web.sections[1].frames[0].image);
});

test('切回原文后所有导出恢复原文与被跳过的段落，网页伴随文档仍保留润色结果', () => {
  const sections = [{ t: 0, end: 2, segments: [{ start: 0, end: 1, text: '润色文', raw: '原文' },
    { start: 1, end: 2, text: '', raw: '被删除的原文', state: 'skipped' }], frames: [{ t: 1, image: 'data:image/jpeg;base64,/9j/AA==' }] }];
  const doc = buildDoc({ polished: false, duration: 2 }, sections);
  const snapshot = upstreamSnapshot(doc, sections);
  assert.deepEqual(snapshot.document.sections.flatMap((s) => s.speech).map((p) => p.text), ['原文', '被删除的原文']);
  assert.equal(snapshot.web.sections[0].segments[0].text, '润色文');
  const settings = { polish: false, showTimestamps: true, imageLevel: 'default' };
  assert.match(markdownOf(doc, settings, sections), /被删除的原文/);
  const bundle = imageBundle(doc, sections, settings);
  assert.equal(bundle.images.length, 1);
  assert.match(bundle.markdown, /被删除的原文/);
});

test('B 站多分 P 的默认首页有明确 p=1 身份；选择分 P 使用自己的标题、CID 与时长', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  let listener;
  const state = { videoData: { title: '系列课', duration: 300, owner: { name: '讲者' }, aid: 1,
    pages: [{ cid: 11, duration: 100, part: '导论' }, { cid: 22, duration: 200, part: '进阶' }] } };
  globalThis.window = { addEventListener: (_, callback) => { listener = callback; }, postMessage(data) {
    queueMicrotask(() => listener({ source: globalThis.window, data: data.dir === 'hello'
      ? { channel: 'c2md-page', dir: 'ready' } : { channel: 'c2md-page', dir: 'res', id: data.id, value: state } }));
  } };
  globalThis.document = { title: '系列课', querySelector: () => ({ duration: 300 }) };
  globalThis.location = { hostname: 'www.bilibili.com', pathname: '/video/BV1CAxaeHEeH', search: '' };
  try {
    const adapter = await import('../src/adapters/bilibili.js');
    const first = await adapter.meta();
    assert.equal(first.url, 'https://www.bilibili.com/video/BV1CAxaeHEeH?p=1');
    assert.equal(first.duration, 100);
    globalThis.location.search = '?p=2';
    const second = await adapter.meta();
    assert.equal(second.title, '系列课 · 进阶');
    assert.equal(second.cid, 22);
    assert.equal(second.duration, 200);
  } finally { Object.assign(globalThis, previous); }
});

test('课程库发布、校验、路径隔离、锁和恢复（Python 标准库）', () => {
  const python = process.env.C2MD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['tests/library.test.py'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('first save uses the discovered library and keeps the same retry identity', async (t) => {
  const priorWindow = globalThis.window, priorChrome = globalThis.chrome;
  t.after(() => { globalThis.window = priorWindow; globalThis.chrome = priorChrome; });
  globalThis.window = { addEventListener() {} };
  let selectedLibrary;
  const saved = [], opened = [];
  globalThis.chrome = { storage: { local: { get: async () => ({ selectedLibrary }) } }, runtime: {
    getManifest: () => ({ version: '0.6.0' }),
    sendMessage: async (message) => {
      if (message.type === 'library.request') { saved.push(message.payload.input); selectedLibrary = 'default'; }
      if (message.type === 'ui.openLibrary') opened.push(new URLSearchParams(message.payload.query));
      return { ok: true, value: { library: 'default', course: 'course-1', version: 'version-1' } };
    },
  } };
  const { Controller } = await import('../src/content/content.js');
  const sections = [{ t: 0, end: 1, segments: [{ start: 0, end: 1, text: 'hello' }], frames: [] }];
  const controller = Object.assign(Object.create(Controller.prototype), {
    doc: buildDoc({ title: 'course', duration: 1 }, sections), settings: { polish: false, imageLevel: 'none' },
    built: { sections, originalEvents: [] }, polisher: { progress: { hasResult: false } },
    exportReady: () => true, exportBusy: () => false, panel: { setState() { assert.fail('saving failed'); } }, panelState: () => ({}),
  });
  await controller.saveLibrary();
  await controller.saveLibrary();
  assert.deepEqual(saved.map((input) => input.library), ['', 'default']);
  assert.equal(saved[0].requestId, saved[1].requestId);
  assert.equal(opened[0].get('library'), 'default');
});

