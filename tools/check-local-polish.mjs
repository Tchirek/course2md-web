// 已启动本机助手后的真实模型冒烟测试。
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8082/v1/chat/completions';
const request = (text, instruction, stream) => ({
  model: 'FireRedPunc+Qwen3.5-2B', stream,
  messages: [
    { role: 'system', content: instruction },
    { role: 'user', content: `待校对：\n${JSON.stringify({ segments: text.map((value, id) => ({ id, text: value })) })}` },
  ],
});

const streamed = await fetch(base, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request(['你好世界今天学习编程', '然后我们开始写代码'], '只修正标点和断句。', true)),
});
assert.equal(streamed.status, 200);
const events = (await streamed.text()).split('\n\n').filter((line) => line.startsWith('data: '));
const content = events.slice(0, -1).map((line) => JSON.parse(line.slice(6)).choices[0].delta.content).join('');
const light = JSON.parse(content).segments;
assert.equal(light.length, 2);
assert(light.every((item) => item.text.length > 0));

const deepResponse = await fetch(base, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request(['这个方法可以让视频转写更快而且最后还可以保存成笔记'], '主动拆分长句，不得增删事实。', false)),
});
assert.equal(deepResponse.status, 200);
const deep = JSON.parse((await deepResponse.json()).choices[0].message.content).segments[0].text;
assert(deep.includes('视频') && deep.includes('笔记'));
process.stdout.write(`FireRedPunc 流式 ${light.length} 段；Qwen fallback：${deep}\n`);
