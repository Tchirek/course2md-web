// 音声の区切り（原版 course2md の asr.rs と同じ規則）：node --test tests/speech-segments.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { invertSilence, parseSilences, pcmData, quietest, rmsHops, speechSegments, splitSmart, wavFile } from '../tools/speech-segments.mjs';

test('silencedetect のログから無音区間を読む（終わらない無音は末尾まで）', () => {
  const log = [
    '[silencedetect @ 000001] silence_start: 0',
    '[silencedetect @ 000001] silence_end: 1.2 | silence_duration: 1.2',
    'size=N/A time=00:00:30.00 bitrate=N/A speed= 900x',
    '[silencedetect @ 000001] silence_start: 12.5',
    '[silencedetect @ 000001] silence_end: 16.25 | silence_duration: 3.75',
    '[silencedetect @ 000001] silence_start: 28.1',
  ].join('\r\n');
  assert.deepEqual(parseSilences(log), [[0, 1.2], [12.5, 16.25], [28.1, Infinity]]);
  assert.deepEqual(invertSilence(30, parseSilences(log)), [[1.2, 12.5], [16.25, 28.1]]);
  // 0.15 秒に満たない切れ端は発話としない
  assert.deepEqual(invertSilence(10, [[0, 4], [4.1, 10]]), []);
  assert.deepEqual(invertSilence(10, []), [[0, 10]]);
});

test('長い発話は切り点手前 3 秒の一番静かな所で切り、どの片も上限を超えない', () => {
  const rms = new Float32Array(500).fill(0.3);
  rms[182] = 0.01; // 18.25 秒
  rms[370] = 0.02; // 37.05 秒
  /** @type {[number, number][]} */
  const pieces = [];
  splitSmart(0, 50, 20, rms, pieces);
  assert.deepEqual(pieces.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]), [[0, 18.25], [18.25, 37.05], [37.05, 50]]);
  assert.ok(pieces.every(([a, b]) => b - a <= 20));
  // 静かな所が範囲の外なら、上限の所で切る（エネルギーが無いときも同じ）
  const none = /** @type {[number, number][]} */ ([]);
  splitSmart(0, 25, 20, null, none);
  assert.deepEqual(none, [[0, 20], [20, 25]]);
  assert.equal(quietest(rms, 30, 40), 37.05);
  assert.equal(quietest(rms, 60, 70), null);
});

test('両端は隣の発話に入らない範囲で 0.25 秒広げ、内側の切り点は広げない', () => {
  const rms = new Float32Array(600).fill(0.3);
  rms[190] = 0; // 19.05 秒
  const segments = speechSegments([[1.1, 1.2], [2, 30], [30.1, 40]], 20, rms, 45);
  // 0.2 秒に満たない発話は捨てる
  assert.deepEqual(segments.map((s) => [s.start, s.end]), [[2, 19.05], [19.05, 30], [30.1, 40]]);
  assert.deepEqual(segments.map((s) => [+s.cutStart.toFixed(2), +s.cutEnd.toFixed(2)]), [
    [1.75, 19.05],
    [19.05, 30.1], // 次の発話の手前で止める
    [30, 40.25], // 広げても前の発話の終わり（30 秒）より前には戻らない
  ]);
  assert.deepEqual(speechSegments([], 20, null, 30), []);
});

test('WAV の PCM 位置を LIST チャンク越しに見つけ、切り出した PCM に正しいヘッダを付ける', () => {
  const pcm = Buffer.alloc(3200);
  pcm.writeInt16LE(1000, 0);
  const plain = wavFile(pcm);
  assert.deepEqual(pcmData(plain), { offset: 44, bytes: 3200 });
  // ffmpeg は fmt と data の間に LIST（エンコーダ名）を挟む
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
  const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  assert.deepEqual(pcmData(withList), { offset: 56, bytes: 3200 });
  const stereo = Buffer.from(plain);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => pcmData(stereo), /16 kHz/);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  assert.equal(rmsHops(samples).length, 1);
  assert.ok(rmsHops(samples)[0] > 0);
});
