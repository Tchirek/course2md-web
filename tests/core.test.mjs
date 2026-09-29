// 核心逻辑单测：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtTs, parseTimestamp, clampTime } from '../src/core/time.js';
import { coalesce, isStandaloneFiller, appendText, dedupeRepeats, partitionByBoundaries } from '../src/core/paragraphs.js';
import { planChunks, tailOf, mapPool } from '../src/core/chunk.js';
import { buildMessages, parsePolishResponse, applyPolish, resetPolish, extractJson } from '../src/core/prompt.js';
import { seekUrl, toMarkdown, toPlainText, buildDoc, fileNameFor } from '../src/core/format.js';
import { withDefaults, normalizeSettings, canPolish, canTranscribe, useLocalPolish, maskSecret, setPath, getPath } from '../src/core/settings.js';
import { visualSections } from '../src/content/visual.js';
import { decodeMediaAudio, FastAudioUnavailable, wavSlice } from '../src/content/fast-audio.js';
import { captureAudio } from '../src/content/capture.js';
import { cookieFileFor } from '../src/background/cookies.js';

test('面板画面分组不改动按章节导出的正文', () => {
  const segments = [0, 80, 100, 210].map((start) => ({ start, end: start + 2, text: String(start) }));
  const chapters = [{ t: 0, title: '第一章', segments }];
  const view = visualSections(chapters, 240);
  assert.deepEqual(view.map((section) => section.segments.map((s) => s.start)), [[0], [80, 100], [210]]);
  assert.equal(view[0].title, '第一章');
  assert.equal(view[1].title, '');
  assert.equal(chapters[0].segments.length, 4);
  view[0].image = 'data:image/jpeg;base64,preview';
  const markdown = toMarkdown(buildDoc({ title: '课' }, chapters), { timestamps: false });
  assert.equal(markdown.match(/## 第一章/g).length, 1);
  assert.doesNotMatch(markdown, /data:image|!\[/);
});

test('图片密度分四档；多档至多每十秒取一张候选帧', () => {
  const sections = [{ t: 0, title: '第一章', segments: Array.from({ length: 181 }, (_, start) => ({ start, end: start + 1, text: '讲述' })) }];
  assert.equal(visualSections(sections, 181, 'none').length, 1);
  assert.equal(visualSections(sections, 181, 'few').length, 2);
  assert.equal(visualSections(sections, 181, 'default').length, 4);
  assert.equal(visualSections(sections, 181, 'many').length, 19);
});

test('复制纯文本先在点击事件内聚焦并复制', async () => {
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  const calls = [];
  const area = { setAttribute() {}, style: {}, focus() { calls.push('focus'); }, select() { calls.push('select'); }, remove() {} };
  globalThis.document = {
    createElement: () => area,
    body: { appendChild() {} },
    execCommand: () => { calls.push('copy'); return true; },
  };
  try {
    const { copyText } = await import('../src/content/content.js');
    assert.equal(await copyText('待复制正文'), true);
    assert.deepEqual(calls, ['focus', 'select', 'copy']);
    assert.equal(area.value, '待复制正文');
  } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
});

test('转录或润色进行中可复制已生成的纯文本，尚未就绪时为空', async () => {
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  globalThis.document = { createElement: () => ({ setAttribute() {}, style: {}, focus() {}, select() {}, remove() {} }), body: { appendChild() {} }, execCommand: () => true };
  try {
    const { Controller } = await import('../src/content/content.js');
    const controller = Object.create(Controller.prototype);
    controller.built = null;
    controller.meta = { title: '课程标题' };
    controller.settings = { polish: false, showTimestamps: true };
    controller.liveSections = [{ t: 0, title: '第一章', segments: [{ start: 0, end: 2, text: '已经转出的正文' }] }];
    const text = controller.plainText();
    assert.match(text, /课程标题/);
    assert.match(text, /\[00:00\] 已经转出的正文/);
    controller.liveSections = null;
    assert.equal(controller.plainText(), '');
    // 润色开启时复制润色后的正文，没润完的段落到哪算哪
    controller.settings = { polish: true, showTimestamps: false };
    controller.liveSections = [{ t: 0, title: '', segments: [{ start: 5, end: 7, text: '润色后的正文', raw: '原始正文', state: 'polished' }] }];
    const polished = controller.plainText();
    assert.match(polished, /润色后的正文/);
    assert.doesNotMatch(polished, /原始正文/);
  } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
});

test('润色文本不能把嵌套的 segments JSON 当作正文', () => {
  assert.equal(parsePolishResponse('{"segments":[{"id":0,"text":"{\\"segments\\":[{\\"id\\":0,\\"text\\":\\"误入正文\\"}]}"}]}'), null);
});

test('下载版 Markdown 在相应讲述段前引用帧，普通复制版不带图', () => {
  const section = { t: 10, title: '片段', image: 'frames/slide_0001.jpg', segments: [{ start: 10, end: 12, text: '讲述。' }] };
  const doc = { meta: { title: '课程', source: 'subtitle', url: 'https://example.com/watch' }, sections: [section] };
  assert.match(toMarkdown(doc, { images: true }), /!\[视频 00:10 的截图\]\(frames\/slide_0001\.jpg\)/);
  assert.doesNotMatch(toMarkdown(doc), /!\[/);
});

test('原版转录段落在润色前已有句末标点', async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    const { organize } = await import('../src/content/pipeline.js');
    const result = organize([{ start: 0, end: 1, text: '我们开始讲课' }], { duration: 2 });
    assert.equal(result.segments[0].text, '我们开始讲课。');
  } finally { globalThis.window = oldWindow; }
});

test('离线音频切片生成 16kHz 单声道 PCM WAV', () => {
  const channel = Float32Array.from([0, 0.5, -0.5, 0]);
  const wav = new DataView(wavSlice({ sampleRate: 4, length: 4, numberOfChannels: 1, getChannelData: () => channel }, 0, 1));
  assert.equal(wav.getUint32(24, true), 16000);
  assert.equal(wav.getUint32(40, true), 32000);
  assert.equal(wav.getInt16(44 + 4000 * 2, true), 16384);
});

test('长视频跳过浏览器整文件解码', async () => {
  await assert.rejects(
    decodeMediaAudio({ currentSrc: 'https://example.com/video.mp4', duration: 181 }, {}),
    FastAudioUnavailable,
  );
});

test('录音器立即失败时退出，不在页面主线程空转', async () => {
  const oldRecorder = globalThis.MediaRecorder;
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { throw new Error('录音器不可用'); }
  };
  const video = {
    currentTime: 0, duration: 60, paused: true, playbackRate: 1, volume: 1, muted: false, ended: false,
    captureStream: () => ({ getAudioTracks: () => [{ stop() {} }] }),
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
  try {
    await assert.rejects(captureAudio(video, { chunkSeconds: 5 }), /录音器未产出音频/);
  } finally {
    globalThis.MediaRecorder = oldRecorder;
  }
});

test('本机提取和浏览器读取都失败时显示原始错误，不启动录音', async () => {
  const oldChrome = globalThis.chrome;
  const oldWindow = globalThis.window;
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: 'CDN 下载失败' }) } };
  globalThis.window = { addEventListener() {} };
  try {
    const { runAsrPipeline } = await import('../src/content/pipeline.js');
    await assert.rejects(
      runAsrPipeline({
        adapter: { video: () => ({ currentSrc: 'blob:video', duration: 1118 }) },
        meta: { url: 'https://www.bilibili.com/video/BV1Hmhq69EAy', duration: 1118 },
        settings: { asr: { endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions' } },
      }),
      /本机音轨提取失败：CDN 下载失败.*浏览器也无法离线读取/s,
    );
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.window = oldWindow;
  }
});

test('点击本机模型生成笔记时先启动模型再提取音轨', async () => {
  const oldChrome = globalThis.chrome;
  const oldWindow = globalThis.window;
  const calls = [];
  globalThis.chrome = { runtime: { sendMessage: async ({ type }) => {
    calls.push(type);
    return type === 'asr.local.start' ? { ok: true, value: { state: 'starting' } } : { ok: false, error: '提取失败' };
  } } };
  globalThis.window = { addEventListener() {} };
  try {
    const { runAsrPipeline } = await import('../src/content/pipeline.js');
    await assert.rejects(runAsrPipeline({
      adapter: { video: () => ({ currentSrc: 'blob:video', duration: 1118 }) },
      meta: { url: 'https://www.bilibili.com/video/BVtest', duration: 1118 },
      settings: { asr: { endpoint: 'http://127.0.0.1:8081/v1/audio/transcriptions' } },
    }), /浏览器也无法离线读取/);
    assert.deepEqual(calls.slice(0, 2), ['asr.local.start', 'asr.fast.start']);
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.window = oldWindow;
  }
});

test('只导出当前视频站点的 cookie，保留 HttpOnly 属性', () => {
  const cookies = [
    { domain: '.bilibili.com', hostOnly: false, path: '/', secure: true, httpOnly: true, name: 'SESSDATA', value: 'test', expirationDate: 2000000000 },
    { domain: '.example.com', hostOnly: false, path: '/', secure: false, name: 'other', value: 'secret' },
  ];
  const file = cookieFileFor('https://www.bilibili.com/video/BV123', cookies);
  assert.match(file, /# Netscape HTTP Cookie File\r\n#HttpOnly_\.bilibili\.com\tTRUE\t\/\tTRUE\t2000000000\tSESSDATA\ttest/);
  assert.doesNotMatch(file, /example|secret/);
  assert.equal(cookieFileFor('https://example.com/video', cookies), '');
});

// ---------- time ----------

test('fmtTs 用 mm:ss，超过一小时才出现小时位', () => {
  assert.equal(fmtTs(0), '00:00');
  assert.equal(fmtTs(65), '01:05');
  assert.equal(fmtTs(599), '09:59');
  assert.equal(fmtTs(3600), '1:00:00');
  assert.equal(fmtTs(3661), '1:01:01');
  assert.equal(fmtTs(59.9), '00:59');
  assert.equal(fmtTs(-5), '00:00');
  assert.equal(fmtTs(NaN), '00:00');
});

test('parseTimestamp 接受 course2md 的所有宽松写法', () => {
  assert.equal(parseTimestamp('1:02:03'), 3723);
  assert.equal(parseTimestamp('01:30'), 90);
  assert.equal(parseTimestamp('90'), 90);
  assert.equal(parseTimestamp('90s'), 90);       // LLM 常写 "120s"
  assert.equal(parseTimestamp('[01:00]'), 60);   // 旧导出标题的方括号
  assert.equal(parseTimestamp('1,5'), 1.5);      // 逗号小数
  assert.equal(parseTimestamp(' 2:00 '), 120);
});

test('parseTimestamp 拒绝异常值', () => {
  assert.equal(parseTimestamp('1:60'), null);    // 秒位 >= 60
  assert.equal(parseTimestamp('1:2:3:4'), null);
  assert.equal(parseTimestamp('-5'), null);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(null), null);
});

test('clampTime 夹取并兜底非有限值', () => {
  assert.equal(clampTime(10, 5), 5);
  assert.equal(clampTime(-1, 5), 0);
  assert.equal(clampTime(NaN, 5), 0);
  assert.equal(clampTime(3, Infinity), 3);
});

// ---------- paragraphs ----------

test('isStandaloneFiller 只认纯语气词', () => {
  assert.equal(isStandaloneFiller('嗯'), true);
  assert.equal(isStandaloneFiller('呃……'), true);
  assert.equal(isStandaloneFiller(' 啊 '), true);
  assert.equal(isStandaloneFiller('嗯好的'), false);
  assert.equal(isStandaloneFiller('对啊'), false);
  assert.equal(isStandaloneFiller(''), false);
});

test('appendText 中文直连、拉丁文加空格', () => {
  assert.equal(appendText('你好', '世界'), '你好世界');
  assert.equal(appendText('hello', 'world'), 'hello world');
  assert.equal(appendText('hello.', 'world'), 'hello. world');
  assert.equal(appendText('你好', 'world'), '你好world');
});

test('coalesce 按 3.5 秒静音断段', () => {
  const segs = coalesce([
    { start: 0, end: 2, text: '第一句' },
    { start: 2.5, end: 4, text: '接得很紧' },
    { start: 9, end: 10, text: '隔了 5 秒' },
  ]);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, '第一句接得很紧');
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, 4);
  assert.equal(segs[1].text, '隔了 5 秒');
});

test('coalesce 按 420 字符上限强制断段', () => {
  const long = '甲'.repeat(300);
  const segs = coalesce([
    { start: 0, end: 1, text: long },
    { start: 1.2, end: 2, text: long },
  ]);
  assert.equal(segs.length, 2);
});

test('coalesce 丢弃独立语气词但保留嵌在句中的语气词', () => {
  const segs = coalesce([
    { start: 0, end: 1, text: '嗯' },
    { start: 1.2, end: 2, text: '我们开始讲' },
    { start: 2.2, end: 3, text: '嗯这个很重要' },
    { start: 9, end: 10, text: '呃' },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, '我们开始讲嗯这个很重要');
});

test('coalesce 忽略空文本与非法事件', () => {
  const segs = coalesce([
    { start: 0, end: 1, text: '   ' },
    { start: 1, end: 2, text: '有内容' },
    null,
    { start: 'x', end: 1, text: '坏事件' },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, '有内容');
});

test('dedupeRepeats 折叠整条循环，但不碰正常重复', () => {
  assert.equal(dedupeRepeats('谢谢大家谢谢大家谢谢大家'), '谢谢大家');
  assert.equal(dedupeRepeats('ok ok ok ok'), 'ok ok');
  // 正常散文里出现重复词不该被删
  assert.equal(dedupeRepeats('这个这个指标上升了'), '这个这个指标上升了');
});

test('partitionByBoundaries 按中点归属，首边界之前归第一段', () => {
  const events = [
    { start: 0, end: 1, text: 'a' },
    { start: 11, end: 12, text: 'b' },
    { start: 21, end: 22, text: 'c' },
  ];
  const out = partitionByBoundaries(events, [0, 10, 20], { mediaEnd: 600 });
  assert.equal(out.length, 3);
  assert.equal(out[0].segments[0].text, 'a');
  assert.equal(out[1].segments[0].text, 'b');
  assert.equal(out[2].segments[0].text, 'c');
  assert.equal(out[1].t, 10);
  assert.equal(out[1].end, 20);
  assert.equal(out[2].end, 600, '末段终点用 mediaEnd');
});

test('partitionByBoundaries 把跨越边界的事件按中点判给前一节', () => {
  // 事件 9-10 中点是 9.5 < 10，按 course2md 的规则归第一节
  const out = partitionByBoundaries([{ start: 9, end: 10, text: 'x' }], [0, 10, 20], {
    mediaEnd: 30,
  });
  assert.equal(out[0].segments.length, 1);
  assert.equal(out[1].segments.length, 0);
});

test('partitionByBoundaries 无边界时返回空数组', () => {
  assert.deepEqual(partitionByBoundaries([{ start: 0, end: 1, text: 'a' }], []), []);
});

// ---------- chunk ----------

test('tailOf 按码点取尾，不切坏多字节字符', () => {
  assert.equal(tailOf('abcdef', 3), 'def');
  assert.equal(tailOf('你好世界', 2), '世界');
  assert.equal(tailOf('短', 5), '短');
  assert.equal([...tailOf('👩‍🚀x', 1)].length, 1);
});

test('planChunks 遵守条数上限且从不切断段落', () => {
  const segs = Array.from({ length: 45 }, (_, i) => ({ start: i, end: i + 1, text: `第${i}段` }));
  const chunks = planChunks(segs, { maxItems: 20, maxChars: 100000 });
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.ids.length), [20, 20, 5]);
  // 所有下标恰好覆盖一次，且各自连续升序
  const all = chunks.flatMap((c) => c.ids);
  assert.deepEqual(all, Array.from({ length: 45 }, (_, i) => i));
});

test('planChunks 按字符预算切块', () => {
  const segs = Array.from({ length: 10 }, () => ({ start: 0, end: 1, text: '甲'.repeat(50) }));
  const chunks = planChunks(segs, { maxItems: 100, maxChars: 120 });
  // 每块最多 2 段（2*50=100 <= 120，3*50 会超）
  assert.deepEqual(chunks.map((c) => c.ids.length), [2, 2, 2, 2, 2]);
});

test('planChunks 携带上一块尾句作为只读上下文', () => {
  const segs = Array.from({ length: 4 }, (_, i) => ({
    start: i, end: i + 1, text: `BODY${i}`,
  }));
  const chunks = planChunks(segs, { maxItems: 2, maxChars: 100000, contextChars: 10 });
  assert.equal(chunks[0].context, '');
  assert.equal(chunks[1].context, 'BODY1');
});

test('planChunks 不跨章节，且换章节时不携带上下文', () => {
  const segs = Array.from({ length: 4 }, (_, i) => ({ start: i, end: i + 1, text: `s${i}` }));
  const chunks = planChunks(segs, { maxItems: 10, maxChars: 100000, sectionOf: (i) => (i < 2 ? 0 : 1) });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].ids, [0, 1]);
  assert.deepEqual(chunks[1].ids, [2, 3]);
  assert.equal(chunks[1].context, '');
});

test('planChunks 续润时跳过已润色段落，并借其尾句作上下文', () => {
  const segs = [
    { start: 0, end: 1, text: '甲已润色', state: 'polished' },
    { start: 1, end: 2, text: '乙已润色', state: 'polished' },
    { start: 2, end: 3, text: '丙待润色' },
    { start: 3, end: 4, text: '丁待润色' },
  ];
  const chunks = planChunks(segs, { maxItems: 20, maxChars: 100000, contextChars: 10, onlyUnpolished: true });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].ids, [2, 3]);
  assert.equal(chunks[0].context, '乙已润色');
});

test('coalesce 把事件的润色状态带进段落：整段润过才算润过', () => {
  const segs = coalesce([
    { start: 0, end: 1, text: '润过的句子', raw: '原来的句子', state: 'polished' },
    { start: 1.5, end: 2, text: '没润过的句子' },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, '润过的句子没润过的句子');
  assert.equal(segs[0].raw, '原来的句子没润过的句子');
  // 段落里有未润色的事件，整段算未润色，续润时会重新处理
  assert.equal(segs[0].state, 'kept');
  assert.ok(!('allPolished' in segs[0]));
});

test('coalesce 全部事件润过时段落标为 polished', () => {
  const segs = coalesce([
    { start: 0, end: 1, text: '第一句润过', raw: '第一句', state: 'polished' },
    { start: 1.5, end: 2, text: '第二句润过', raw: '第二句', state: 'polished' },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].state, 'polished');
  assert.equal(segs[0].raw, '第一句第二句');
});

test('mapPool 保持顺序、并发受限、个别失败不拖垮整批', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (n === 3) throw new Error('boom');
    return n * 10;
  });
  assert.deepEqual(results, [10, 20, null, 40, 50]);
  assert.ok(peak <= 2, `并发峰值 ${peak} 应 <= 2`);
});

// ---------- prompt ----------

test('buildMessages 输出严格的逐条 id 契约', () => {
  const segments = [{ start: 0, end: 1, text: '甲' }, { start: 1, end: 2, text: '乙' }];
  const msgs = buildMessages({
    segments,
    chunk: { ids: [0, 1], context: '' },
    meta: { title: '线性代数', uploader: '张三' },
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /segments/);
  assert.match(msgs[0].content, /不得增删条目/);
  assert.match(msgs[1].content, /"id":0/);
  assert.match(msgs[1].content, /线性代数/);
});

test('buildMessages 把术语表与只读上下文分开标注', () => {
  const segments = [{ start: 0, end: 1, text: '甲' }];
  const msgs = buildMessages({
    segments,
    chunk: { ids: [0], context: '上一块的尾巴' },
    meta: { title: 'T' },
    glossary: 'Transformer\nMoE',
  });
  assert.match(msgs[1].content, /术语表/);
  assert.match(msgs[1].content, /Transformer/);
  assert.match(msgs[1].content, /不要.*输出这一部分/);
  assert.match(msgs[1].content, /上一块的尾巴/);
});

test('extractJson 抠出被围栏或废话包裹的 JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，结果是 {"a":1} 以上'), { a: 1 });
  assert.deepEqual(extractJson('[1,2]'), [1, 2]);
  // 字符串里的花括号不能骗到配对扫描
  assert.deepEqual(extractJson('{"a":"}"}'), { a: '}' });
  assert.equal(extractJson('没有任何 json'), null);
});

test('parsePolishResponse 容忍包装但拒绝坏条目', () => {
  const ok = parsePolishResponse('{"segments":[{"id":0,"text":"甲"},{"id":1,"text":"乙"}]}');
  assert.deepEqual(ok, [{ id: 0, text: '甲' }, { id: 1, text: '乙' }]);

  const arr = parsePolishResponse('[{"id":3,"text":"丙"}]');
  assert.deepEqual(arr, [{ id: 3, text: '丙' }]);

  assert.equal(parsePolishResponse('{"segments":[{"text":"缺 id"}]}'), null);
  assert.equal(parsePolishResponse('{"segments":[]}'), null);
  assert.equal(parsePolishResponse('不是 json'), null);
});

test('applyPolish 只在 id 完全匹配时写回', () => {
  const segs = [
    { start: 0, end: 1, text: '原文甲', state: 'kept' },
    { start: 1, end: 2, text: '原文乙', state: 'kept' },
  ];

  const mismatch = applyPolish(segs, [0, 1], [{ id: 0, text: '只给了一条' }]);
  assert.equal(mismatch.applied, false);
  assert.equal(segs[0].text, '原文甲', 'id 不匹配时不得改动原文');

  const alien = applyPolish(segs, [0, 1], [{ id: 0, text: 'a' }, { id: 9, text: 'b' }]);
  assert.equal(alien.applied, false);
  assert.equal(segs[0].text, '原文甲');

  const ok = applyPolish(segs, [0, 1], [{ id: 0, text: '润色甲' }, { id: 1, text: '润色乙' }]);
  assert.equal(ok.applied, true);
  assert.equal(segs[0].text, '润色甲');
  assert.equal(segs[0].raw, '原文甲', '原文必须留存为 provenance');
  assert.equal(segs[0].state, 'polished');
});

test('applyPolish 把空串当作删除语气词', () => {
  const segs = [
    { start: 0, end: 1, text: '啊', state: 'kept' },
    { start: 1, end: 2, text: '正文', state: 'kept' },
  ];
  const { applied, removed } = applyPolish(segs, [0, 1], [
    { id: 0, text: '' },
    { id: 1, text: '正文' },
  ]);
  assert.equal(applied, true);
  assert.equal(removed, 1);
  assert.equal(segs[0].state, 'skipped');
  assert.equal(segs[1].state, 'polished');
});

test('resetPolish 还原原文并清掉 provenance', () => {
  const segs = [{ start: 0, end: 1, text: '润色后', raw: '原文', state: 'polished' }];
  resetPolish(segs);
  assert.equal(segs[0].text, '原文');
  assert.equal(segs[0].raw, undefined);
  assert.equal(segs[0].state, 'kept');
});

// ---------- format ----------

test('seekUrl 覆盖已有的 t 参数并保留其他参数', () => {
  assert.equal(
    seekUrl('https://www.youtube.com/watch?v=abc&t=30', 90),
    'https://www.youtube.com/watch?v=abc&t=90',
  );
  assert.equal(
    seekUrl('https://www.bilibili.com/video/BV1x?p=2', 125),
    'https://www.bilibili.com/video/BV1x?p=2&t=125',
  );
  // 非法 URL 原样返回，不抛
  assert.equal(seekUrl('not a url', 10), 'not a url');
});

test('toMarkdown 三种开关组合', () => {
  const doc = buildDoc(
    { title: '讲义', uploader: '张三', duration: 3725, url: 'https://example.com/v?v=1', source: 'subtitle' },
    [{ title: '开场', t: 0, end: 60, segments: [{ start: 12, end: 20, text: '大家好', state: 'kept' }] }],
  );

  const full = toMarkdown(doc, { timestamps: true, links: true });
  assert.match(full, /^# 讲义$/m);
  assert.match(full, /## \[00:00\]\(https:\/\/example\.com\/v\?v=1&t=0\) 开场/);
  assert.match(full, /\[00:12\]\(https:\/\/example\.com\/v\?v=1&t=12\) 大家好/);
  assert.match(full, /时长：1:02:05/);

  const plain = toMarkdown(doc, { timestamps: true, links: false });
  assert.match(plain, /## \[00:00\] 开场/);
  assert.match(plain, /\[00:12\] 大家好/);
  assert.doesNotMatch(plain, /t=12/);

  const bare = toMarkdown(doc, { timestamps: false });
  assert.doesNotMatch(bare, /00:12/);
  assert.match(bare, /^大家好$/m);
  assert.match(bare, /^## 开场$/m);
});

test('toMarkdown 过滤被标记为删除的段落', () => {
  const doc = buildDoc({ title: 'T', url: 'u' }, [
    {
      t: 0, end: 10,
      segments: [
        { start: 0, end: 1, text: '保留', state: 'kept' },
        { start: 1, end: 2, text: '删掉', state: 'skipped' },
      ],
    },
  ]);
  const md = toMarkdown(doc);
  assert.match(md, /保留/);
  assert.doesNotMatch(md, /删掉/);
});

test('toMarkdown 不产出连续三个换行', () => {
  const doc = buildDoc({ title: 'T', url: 'u' }, [
    { t: 0, end: 10, segments: [{ start: 0, end: 1, text: 'a', state: 'kept' }] },
    { t: 10, end: 20, segments: [{ start: 10, end: 11, text: 'b', state: 'kept' }] },
  ]);
  assert.doesNotMatch(toMarkdown(doc), /\n{3,}/);
});

test('toMarkdown 防伪造标题：strip 标题里的换行与行首井号', () => {
  const doc = buildDoc({ title: '# 假标题\n第二行', url: 'u' }, []);
  const md = toMarkdown(doc, { timestamps: false });
  assert.match(md, /^# 假标题 第二行$/m);
  assert.doesNotMatch(md, /^## 第二行/m);
});

test('toPlainText 不含 markdown 标记', () => {
  const doc = buildDoc({ title: 'T', url: 'https://e.com' }, [
    { t: 0, end: 5, segments: [{ start: 3, end: 4, text: '正文', state: 'kept' }] },
  ]);
  const text = toPlainText(doc);
  assert.doesNotMatch(text, /\[.*\]\(.*\)/);
  assert.match(text, /\[00:03\] 正文/);
});

test('fileNameFor 去掉文件系统非法字符', () => {
  assert.equal(fileNameFor('a/b:c*d?e"f<g>h|i'), 'a b c d e f g h i.md');
  assert.equal(fileNameFor(''), 'notes.md');
  assert.equal(fileNameFor('x'.repeat(200)).length, 83);
});

// ---------- settings ----------

test('withDefaults 补齐缺失字段而不覆盖已存的', () => {
  const s = withDefaults({ llm: { model: 'x' } });
  assert.equal(s.llm.model, 'x');
  assert.equal(s.llm.concurrency, 4);
  assert.equal(s.source, 'subtitle');
});

test('旧跳转开关被移除，图片密度回退到默认', () => {
  const { settings } = normalizeSettings({ showTimestamps: false, clickToSeek: false, imageLevel: 'invalid' });
  assert.equal('clickToSeek' in settings, false);
  assert.equal(settings.imageLevel, 'default');
});

test('normalizeSettings 夹取并发并清理 URL 尾巴', () => {
  const { settings } = normalizeSettings({
    llm: { baseUrl: 'https://api.deepseek.com/v1///', concurrency: 999 },
  });
  assert.equal(settings.llm.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(settings.llm.concurrency, 16);
});

test('未配置远端 LLM 时允许本机润色且不显示误导性警告', () => {
  const { settings, notes } = normalizeSettings({ polish: true, llm: { baseUrl: '', model: '' } });
  assert.equal(settings.polish, true);
  assert.equal(notes.length, 0);
  assert.equal(canPolish(settings), false);
});

test('本机与自定义润色模型可明确切换，旧设置沿用原选择', () => {
  const llm = { baseUrl: 'https://example.test/v1', model: 'custom' };
  assert.equal(useLocalPolish(withDefaults({ llm })), false);
  assert.equal(useLocalPolish(withDefaults({ polishEngine: 'local', llm })), true);
  assert.equal(useLocalPolish(withDefaults({ polishEngine: 'custom', llm })), false);
  assert.equal(useLocalPolish(withDefaults({ polishEngine: 'custom' })), false);
  assert.equal(useLocalPolish(withDefaults({})), true);
});

test('canPolish / canTranscribe 判定可运行条件', () => {
  assert.equal(canPolish({ polish: true, llm: { baseUrl: 'http://x/v1', model: 'm' } }), true);
  assert.equal(canPolish({ polish: true, llm: { baseUrl: 'ftp://x', model: 'm' } }), false);
  assert.equal(canPolish({ polish: false, llm: { baseUrl: 'http://x/v1', model: 'm' } }), false);

  // 用字幕时不需要 ASR 配置
  assert.equal(canTranscribe({ source: 'subtitle', asr: {} }), true);
  assert.equal(
    canTranscribe({ source: 'asr', asr: { endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions' } }),
    true,
  );
  assert.equal(canTranscribe({ source: 'asr', asr: { endpoint: 'nope' } }), false);
  assert.equal(canTranscribe({ source: 'asr', asr: { endpoint: '' } }), false);
});

test('normalizeSettings 对未配置的本地转录给出可读提示', () => {
  const { notes } = normalizeSettings({ source: 'asr', asr: { endpoint: '' } });
  assert.ok(notes.some((n) => n.includes('本机 ASR')), `应提示填写 ASR 地址，实际：${notes.join('|')}`);
});

test('本地转录默认不加速：倍率大于 1 会变调并降低识别质量', () => {
  const s = withDefaults({});
  assert.equal(s.asr.playbackRate, 1, '默认倍率必须是 1');
  assert.equal(s.asr.chunkSeconds, 30);
});

test('本机转录把视频标题作为识别提示传给模型', async () => {
  const { transcribe } = await import('../src/background/asr.js');
  const original = globalThis.fetch;
  let prompt;
  globalThis.fetch = async (_url, options) => {
    prompt = options.body.get('prompt');
    return new Response(JSON.stringify({ text: '广德寺' }), { status: 200 });
  };
  try {
    const result = await transcribe({ endpoint: 'http://127.0.0.1:8081/v1/audio/transcriptions',
      model: 'small', prompt: '宁海广德寺仿日有多专业？', audio: new Uint8Array([1]) });
    assert.equal(result.ok, true);
    assert.equal(prompt, '宁海广德寺仿日有多专业？');
  } finally { globalThis.fetch = original; }
});

test('getPath / setPath 处理嵌套字段', () => {
  const o = { llm: {} };
  setPath(o, 'llm.apiKey', 'k');
  assert.equal(getPath(o, 'llm.apiKey'), 'k');
  assert.equal(getPath(o, 'llm.missing.deep'), undefined);
});

test('maskSecret 只留尾四位', () => {
  assert.equal(maskSecret('sk-1234567890'), '••••7890');
  assert.equal(maskSecret('abc'), '••••');
  assert.equal(maskSecret(''), '');
});
