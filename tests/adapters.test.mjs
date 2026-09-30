// 字幕解析与端到端管线测试：node --test tests/adapters.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseVtt, parseSrt, parseJson3, parseTimedTextXml, parseBilibili, overrunsDuration,
  parseSubtitle, collapseCues, looksRolling, cleanCueText, parseCueTime, normalizeChapters,
  parseChaptersVtt, languageLabel,
} from '../src/core/subtitles.js';
import { readFileSync } from 'node:fs';
import { coalesce } from '../src/core/paragraphs.js';
import { planChunks } from '../src/core/chunk.js';
import { buildMessages, parsePolishResponse, applyPolish } from '../src/core/prompt.js';
import { buildDoc, toMarkdown, toJson } from '../src/core/format.js';

// ---------- 基础解析 ----------

test('滚动字幕中的长停顿之后，同一句再次出现仍然保留', () => {
  const cues = [
    { start: 0, end: 1, lines: ['hello'] },
    { start: 1, end: 2, lines: ['hello', 'world'] },
    { start: 2, end: 3, lines: ['world', 'again'] },
    { start: 10, end: 11, lines: ['again'] },
  ];
  assert.equal(looksRolling(cues), true);
  assert.deepEqual(collapseCues(cues).map((e) => [e.start, e.text]),
    [[0, 'hello'], [1, 'world'], [2, 'again'], [10, 'again']]);
});

test('parseCueTime 接受点/逗号小数与省略小时', () => {
  assert.equal(parseCueTime('00:01:05.500'), 65.5);
  assert.equal(parseCueTime('01:05,250'), 65.25);
  assert.equal(parseCueTime('65.5'), 65.5);
  assert.equal(parseCueTime('0:00:03.0'), 3);
  assert.equal(parseCueTime('nonsense'), null);
});

test('cleanCueText 去标记、解实体、合并换行', () => {
  assert.equal(cleanCueText('你好\n世界'), '你好 世界');
  assert.equal(cleanCueText('<v Speaker>说话</v>'), '说话');
  assert.equal(cleanCueText('<c.yellow>逐</c><c.yellow>词</c>'), '逐词');
  assert.equal(cleanCueText('<00:00:01.000>卡拉OK'), '卡拉OK');
  assert.equal(cleanCueText('&lt;tag&gt; &amp; &nbsp;x'), '<tag> & x');
  // 转义过的实体只解一层：&amp;#60; 是字面的「&#60;」，不是「<」
  assert.equal(cleanCueText('&amp;#60; &amp;lt; &#60; &#x4e2d;'), '&#60; &lt; < 中');
  assert.equal(cleanCueText('&#39;a&#39; &bogus; &#1114112;'), "'a' &bogus; &#1114112;");
  assert.equal(cleanCueText('<i>斜体</i>'), '斜体');
  assert.equal(cleanCueText('  a   b  '), 'a b');
});

// ---------- VTT ----------

test('parseVtt 跳过 NOTE/STYLE/REGION，容忍 cue id 与定位设置', () => {
  const vtt = `WEBVTT
Kind: captions
Language: zh

NOTE 这是注释
不该被解析

STYLE
::cue { color: white }

REGION
id:foo

cue-1
00:00:01.000 --> 00:00:03.000 align:start position:0%
第一句

00:00:03.500 --> 00:00:05.000
第二句
换行继续
`;
  const events = parseVtt(vtt);
  assert.equal(events.length, 2);
  assert.equal(events[0].start, 1);
  assert.equal(events[0].end, 3);
  assert.equal(events[0].text, '第一句');
  assert.equal(events[1].text, '第二句 换行继续');
  assert.equal(events[1].end, 5);
});

// 实物：MIT OpenCourseWare 6.0001 第 2 讲（CC BY-NC-SA 4.0）YouTube 自动字幕的 VTT 原样摘录。
// 每条 cue 把上一条的末行原样重复在第一行、第二行才是新词，中间夹着 10ms 的「停留」cue；
// 空白 cue 表示画面清空（其后再说一次的 okay 是真的重复）。期望值取自同一轨道的 json3 原文。
const YOUTUBE_AUTO_VTT = [
  'WEBVTT',
  'Kind: captions',
  'Language: en',
  '',
  '00:00:00.680 --> 00:00:02.550 align:start position:0%',
  ' ',
  'the<00:00:00.840><c> following</c><00:00:01.319><c> content</c><00:00:01.760><c> is</c><00:00:02.000><c> provided</c><00:00:02.320><c> under</c>',
  '',
  '00:00:02.550 --> 00:00:02.560 align:start position:0%',
  'the following content is provided under',
  ' ',
  '',
  '00:00:02.560 --> 00:00:05.269 align:start position:0%',
  'the following content is provided under',
  'a<00:00:02.720><c> Creative</c><00:00:03.120><c> Commons</c><00:00:03.560><c> license</c><00:00:04.560><c> your</c><00:00:04.839><c> support</c>',
  '',
  '00:00:05.269 --> 00:00:05.279 align:start position:0%',
  'a Creative Commons license your support',
  ' ',
  '',
  '00:00:05.279 --> 00:00:07.389 align:start position:0%',
  'a Creative Commons license your support',
  'will<00:00:05.480><c> help</c><00:00:05.680><c> MIT</c><00:00:06.120><c> open</c><00:00:06.440><c> courseware</c><00:00:07.000><c> continue</c>',
  '',
  '00:00:07.389 --> 00:00:07.399 align:start position:0%',
  'will help MIT open courseware continue',
  ' ',
  '',
  '00:09:28.110 --> 00:09:28.120 align:start position:0%',
  ' ',
  ' ',
  '',
  '00:09:28.120 --> 00:09:32.110 align:start position:0%',
  ' ',
  'okay',
  '',
  '00:09:32.110 --> 00:09:32.120 align:start position:0%',
  ' ',
  ' ',
  '',
  '00:09:32.120 --> 00:09:34.269 align:start position:0%',
  ' ',
  'okay',
  '',
  '00:09:34.269 --> 00:09:34.279 align:start position:0%',
  'okay',
  ' ',
  '',
  '00:09:34.279 --> 00:09:36.790 align:start position:0%',
  'okay',
  'so<00:09:35.279><c> printing</c><00:09:35.640><c> things</c><00:09:35.800><c> out</c><00:09:35.920><c> to</c><00:09:36.079><c> the</c><00:09:36.240><c> console</c><00:09:36.560><c> is</c>',
  '',
].join('\n');

const words = (events) => events.map((e) => e.text).join(' ').split(/\s+/).filter(Boolean);

test('parseVtt 按行收拢 YouTube 自动字幕的滚动重复，结果与 json3 原文逐词一致', () => {
  const events = parseVtt(YOUTUBE_AUTO_VTT);
  assert.equal(
    words(events).join(' '),
    'the following content is provided under a Creative Commons license your support ' +
    'will help MIT open courseware continue okay okay so printing things out to the console is',
  );
  // 每条新行是一条事件，从它出现的那一刻开始；停留 cue 只把结束时间顺延
  assert.deepEqual(events.slice(0, 3).map((e) => [e.start, e.end]), [[0.68, 2.56], [2.56, 5.279], [5.279, 7.399]]);
});

test('人手字幕首尾相接也不会被拼接：评审给出的三组与逐字重叠', () => {
  const pairs = [
    ['So this is the plan', 'and then we iterate'],
    ['we are going to', 'together build this'],
    ['这是第一个问题', '问题的关键在于'],
    ['with the', 'them today'],
  ];
  for (const [a, b] of pairs) {
    const srt = `1\n00:00:00,000 --> 00:00:02,000\n${a}\n\n2\n00:00:02,000 --> 00:00:04,000\n${b}\n`;
    assert.deepEqual(parseSrt(srt).map((e) => e.text), [a, b]);
  }
});

test('把真实正文切成首尾相接的 cue，解析后一字不差（英文按词、中文按字）', () => {
  const two = (n) => String(n).padStart(2, '0');
  const stamp = (t) => `${two(Math.floor(t / 3600))}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)},000`;
  const cuesOf = (units, size, joiner) => {
    let srt = '';
    for (let i = 0, n = 1; i < units.length; i += size, n++) {
      srt += `${n}\n${stamp((n - 1) * 2)} --> ${stamp(n * 2)}\n${units.slice(i, i + size).join(joiner)}\n\n`;
    }
    return srt;
  };
  // 标签与实体会被字幕清理掉，先去掉，只留正文
  const en = readFileSync(new URL('../README.en.md', import.meta.url), 'utf8')
    .replace(/<[^>]*>|&[#\w]+;|[<>]/g, ' ').split(/\s+/).filter(Boolean);
  for (const size of [5, 7, 9]) {
    assert.deepEqual(words(parseSrt(cuesOf(en, size, ' '))), en, `英文 ${size} 词一条`);
  }
  const zh = [...readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/[\s\x00-\x7f]/g, '')];
  for (const size of [8, 12, 16]) {
    assert.equal(parseSrt(cuesOf(zh, size, '')).map((e) => e.text).join(''), zh.join(''), `中文 ${size} 字一条`);
  }
});

test('逐字展开的字幕（同一行越写越长）只在词边界处收拢', () => {
  const growing = parseSrt([
    '1\n00:00:00,000 --> 00:00:01,000\n大家好\n',
    '2\n00:00:01,000 --> 00:00:02,000\n大家好今天\n',
    '3\n00:00:02,000 --> 00:00:03,000\n大家好今天讲线性代数\n',
  ].join('\n'));
  assert.deepEqual(growing.map((e) => [e.text, e.start, e.end]), [['大家好今天讲线性代数', 0, 3]]);
  // "to" 并不是 "together" 的一个词：不能当作同一行的延长
  const cues = [
    { start: 0, end: 1, lines: ['we are going to'] },
    { start: 1, end: 2, lines: ['we are going together'] },
    { start: 2, end: 3, lines: ['build this'] },
  ];
  assert.equal(looksRolling(cues), false);
});

test('不滚动的字幕只合并时间上接续的同一句（与原版 subtitle.rs 一致）', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n机器学习是\n\n2\n00:00:02,000 --> 00:00:03,000\n机器学习是\n\n' +
    '3\n00:00:03,000 --> 00:00:04,000\n一门人工智能分支\n\n4\n00:00:09,000 --> 00:00:10,000\n一门人工智能分支\n';
  const events = parseSrt(srt);
  assert.deepEqual(events.map((e) => [e.text, e.start, e.end]), [
    ['机器学习是', 1, 3],
    ['一门人工智能分支', 3, 4],
    // 隔了 5 秒又说一次，是讲师真的重复，必须保留
    ['一门人工智能分支', 9, 10],
  ]);
});

test('json3 不做任何合并：事件时间重叠是二行显示，不是重复', () => {
  const events = parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'okay' }] },
      { tStartMs: 2000, dDurationMs: 4000, segs: [{ utf8: 'okay' }] },
      { tStartMs: 3000, dDurationMs: 4000, segs: [{ utf8: 'with the' }] },
      { tStartMs: 4000, dDurationMs: 4000, segs: [{ utf8: 'them today' }] },
    ],
  });
  assert.deepEqual(events.map((e) => e.text), ['okay', 'okay', 'with the', 'them today']);
});

// ---------- SRT ----------

test('parseSrt 处理 BOM、序号行与多行文本', () => {
  const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n第一行\r\n第二行\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n下一句\r\n';
  const events = parseSrt(srt);
  assert.equal(events.length, 2);
  assert.equal(events[0].text, '第一行 第二行');
  assert.equal(events[1].start, 4);
  assert.equal(events[1].end, 6);
});

// ---------- json3 ----------

test('parseJson3 拼接 segs、跳过定位事件、按毫秒换算', () => {
  const json = JSON.stringify({
    events: [
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: '你好' }, { utf8: '世界' }] },
      { tStartMs: 2500, segs: [{ utf8: '\n' }] },              // 无 dDurationMs 的换行事件
      { tStartMs: 3000, dDurationMs: 1500, aAppend: 1 },        // 定位事件，无 segs
      { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: '第三句' }] },
    ],
  });
  const events = parseJson3(json);
  assert.equal(events.length, 2, '换行事件与定位事件都应被跳过');
  assert.equal(events[0].start, 1);
  assert.equal(events[0].end, 3);
  assert.equal(events[0].text, '你好世界');
  assert.equal(events[1].start, 5);
  assert.equal(events[1].text, '第三句');
});

test('parseJson3 直接接受已解析的对象', () => {
  const events = parseJson3({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'x' }] }] });
  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'x');
});

// ---------- timedtext XML ----------

test('parseTimedTextXml 解实体并读取 start/dur', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<transcript>
<text start="0.5" dur="2.5">第一句 &amp; 更多</text>
<text start="3.0" dur="1.5">第二句 &lt;代码&gt;</text>
</transcript>`;
  const events = parseTimedTextXml(xml);
  assert.equal(events.length, 2);
  assert.equal(events[0].start, 0.5);
  assert.equal(events[0].end, 3);
  assert.equal(events[0].text, '第一句 & 更多');
  assert.equal(events[1].text, '第二句 <代码>');
});

// ---------- B 站 ----------

test('overrunsDuration は動画の長さを明らかに超える字幕だけを別動画のものとみなす', () => {
  const until = (end) => [{ start: 0, end: 2 }, { start: end - 3, end }];
  // 実測で混入した別動画の字幕：607 秒の動画に 1114 秒まで続く字幕
  assert.equal(overrunsDuration(until(1114), 607), true);
  assert.equal(overrunsDuration(until(3660), 387), true);
  // 本物の字幕は長さに収まる。終端の数秒のずれは許す
  assert.equal(overrunsDuration(until(600), 607), false);
  assert.equal(overrunsDuration(until(612), 607), false);
  // 長さ不明（0・ライブ）や空の字幕は判定しない
  assert.equal(overrunsDuration(until(5000), 0), false);
  assert.equal(overrunsDuration([], 607), false);
});

test('parseBilibili 读取 body 的 from/to/content 并排序', () => {
  const json = JSON.stringify({
    body: [
      { from: 5.0, to: 7.5, content: '后半句' },
      { from: 0.5, to: 2.0, content: '前半句' },
    ],
  });
  const events = parseBilibili(json);
  assert.equal(events.length, 2);
  assert.equal(events[0].text, '前半句');
  assert.equal(events[0].start, 0.5);
  assert.equal(events[1].text, '后半句');
});

// ---------- 自动识别 ----------

test('parseSubtitle 自动识别四种格式', () => {
  assert.equal(parseSubtitle('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n甲').length, 1);
  assert.equal(parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\n乙').length, 1);
  assert.equal(parseSubtitle('{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"丙"}]}]}').length, 1);
  assert.equal(parseSubtitle('{"body":[{"from":0,"to":1,"content":"丁"}]}').length, 1);
  assert.equal(parseSubtitle('<transcript><text start="0" dur="1">戊</text></transcript>').length, 1);
});

test('parseSubtitle 对垃圾输入返回空数组而不抛错', () => {
  for (const bad of ['', '   ', '这不是字幕', '<html><body>页面</body></html>', '{坏 json']) {
    assert.deepEqual(parseSubtitle(bad), [], `输入 ${JSON.stringify(bad)} 应返回空`);
  }
});

// ---------- 章节 ----------

test('parseChaptersVtt 把章节 cue 变成时间边界', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:10.000
开场

00:01:30.000 --> 00:01:40.000
讲第一个概念
`;
  const chapters = normalizeChapters(parseChaptersVtt(vtt));
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '开场');
  assert.equal(chapters[1].t, 90);
});

test('normalizeChapters 去重、排序、容错', () => {
  const out = normalizeChapters([
    { title: 'B', t: 60 },
    { title: 'A', t: 0 },
    { title: 'A2', t: 0 },        // 与上一条同秒，去重
    { title: '', t: 120 },        // 空标题兜底
    { title: 'bad', t: NaN },     // 非法时间丢弃
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.t), [0, 60, 120]);
  assert.equal(out[2].title, '未命名章节');
});

test('languageLabel 给出可读标签', () => {
  assert.equal(languageLabel('zh-Hans'), '简体中文');
  assert.equal(languageLabel('en'), '英语');
  assert.equal(languageLabel('en-US'), '英语（en-US）');
  assert.equal(languageLabel('xx-YY'), 'xx-YY');
  assert.equal(languageLabel(''), '未知语言');
});

// ---------- 端到端：字幕 -> 段落 -> 分块 -> 润色 -> Markdown ----------

test('coalesce 在输入已带原文时累积出完整 raw', () => {
  // 模拟「已润色过的转写再按新设置重新组织」：text 是润色版，raw 是原文
  const segments = coalesce([
    { start: 0, end: 2, text: '矩阵是一个数表', raw: '矩阵是一个数表啊' },
    { start: 2.2, end: 4, text: '可以用它解方程', raw: '可以用它解方程嗯' },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, '矩阵是一个数表可以用它解方程');
  assert.equal(segments[0].raw, '矩阵是一个数表啊可以用它解方程嗯');
});

test('端到端：字幕到 Markdown，时间戳与跳转链接遵循勾选', () => {
  // 一段 40 秒的假字幕，含静音断句、语气词、以及一个超过 3.5 秒的停顿
  const cues = [
    { start: 0.0, end: 2.0, text: '大家好' },
    { start: 2.2, end: 5.0, text: '今天讲线性代数' },
    { start: 5.2, end: 7.0, text: '嗯' },
    { start: 7.2, end: 10.0, text: '先看矩阵' },
    // 静音 5 秒 -> 断段
    { start: 15.0, end: 18.0, text: '矩阵是一个数表' },
  ];

  const segments = coalesce(cues);
  assert.equal(segments.length, 2, '3.5 秒静音处应断段');
  assert.equal(segments[0].text, '大家好今天讲线性代数先看矩阵', '语气词应被丢弃且中文直连');
  assert.equal(segments[1].start, 15);

  const chapters = normalizeChapters([{ title: '开场', t: 0 }]);
  const doc = buildDoc(
    { title: '线性代数第一讲', uploader: '张老师', duration: 3600, url: 'https://www.youtube.com/watch?v=abc', source: 'subtitle' },
    [{ title: chapters[0].title, t: 0, end: 3600, segments }],
  );

  const full = toMarkdown(doc, { timestamps: true, links: true });
  assert.match(full, /## \[00:00\]\(https:\/\/www\.youtube\.com\/watch\?v=abc&t=0\) 开场/);
  assert.match(full, /\[00:00\]\(https:\/\/www\.youtube\.com\/watch\?v=abc&t=0\) 大家好今天讲线性代数先看矩阵/);
  assert.match(full, /\[00:15\]\(https:\/\/www\.youtube\.com\/watch\?v=abc&t=15\) 矩阵是一个数表/);

  const bare = toMarkdown(doc, { timestamps: false });
  assert.doesNotMatch(bare, /00:15/);
  assert.match(bare, /大家好今天讲线性代数先看矩阵/);
});

test('端到端：分块 -> 润色 -> 应用，且 id 错位时整块保留原文', () => {
  const segments = coalesce([
    { start: 0, end: 2, text: '这个是那个呃' },
    { start: 2.2, end: 4, text: '第一个概念' },
    { start: 20, end: 22, text: '第二个概念' },
  ]);
  assert.equal(segments.length, 2);

  const chunks = planChunks(segments, { maxItems: 1, maxChars: 1000, contextChars: 20 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].context, segments[0].text, '第二块应带上第一块的尾句');

  // 第一块正常润色；第二块模型返回错 id -> 保留原文
  const msgs = buildMessages({ segments, chunk: chunks[0], meta: { title: 'T' } });
  assert.equal(msgs.length, 2);

  const ok = parsePolishResponse('{"segments":[{"id":0,"text":"这个是那个"}]}');
  assert.equal(applyPolish(segments, chunks[0].ids, ok).applied, true);
  assert.equal(segments[0].text, '这个是那个');
  // raw 保留的是润色前那一段的完整原文（该段由两条 cue 合并而成）
  assert.equal(segments[0].raw, '这个是那个呃第一个概念');

  const bad = parsePolishResponse('{"segments":[{"id":42,"text":"乱来"}]}');
  assert.equal(applyPolish(segments, chunks[1].ids, bad).applied, false);
  assert.equal(segments[1].text, '第二个概念', 'id 对不上必须保留原文');
});

test('端到端：结构化 JSON 带 schema 版本且过滤已删段落', () => {
  const segments = coalesce([{ start: 0, end: 1, text: '留下' }]);
  segments.push({ start: 1, end: 2, text: '删掉', state: 'skipped' });
  const doc = buildDoc({ title: 'T', url: 'https://e.com', source: 'asr' }, [
    { t: 0, end: 10, segments },
  ]);
  const parsed = JSON.parse(toJson(doc));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.generator.name, 'course2md-web');
  assert.equal(parsed.meta.source, 'asr');
  assert.equal(parsed.sections[0].segments.length, 1);
  assert.equal(parsed.sections[0].segments[0].text, '留下');
});
