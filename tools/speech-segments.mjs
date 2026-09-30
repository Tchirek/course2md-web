// 文字起こしに送る音声の区切り方。原版 course2md の asr.rs（ffmpeg_vad・normalize_segments・
// split_smart）をそのまま移したもの。両方が同じ所で切れば、同じ音声からは同じ時刻の段落ができる。
//
// 以前は 30 秒ごとに機械的に切っていたため、語の途中で切れ、無音も区切りとして残らなかった。
// Qwen3-ASR はタイムスタンプを返さないので、区切りそのものが事件の時刻になる。
// 無音で切れば、事件は話し始めの時刻から始まり、段落を分ける 3.5 秒の間も失われない。

/** ffmpeg の無音検出：-28dB 以下が 0.4 秒続けば無音（原版 SILENCEDETECT_AF） */
export const SILENCE_FILTER = 'silencedetect=noise=-28dB:d=0.4';
/** 送る音声の両端を無音側へ広げる秒数（隣の発話には入らない） */
const PAD = 0.25;
/** 長すぎる発話は、目標の切り点から手前この秒数の範囲で一番静かな所で切る */
const SPLIT_WINDOW = 3;
/** 機械的に切るときの最短の片 */
const MIN_PIECE = 1;
/** 切り点を区間の頭に寄せすぎない（エネルギーが異常でも極端に短い片を作らない） */
const MIN_HARD_CUT = 0.5;
/** エネルギーを測る窓（秒） */
const HOP = 0.1;
/** 16 kHz モノラルでの一窓のサンプル数 */
const HOP_SAMPLES = 1600;

/**
 * silencedetect のログから無音区間を取り出す。
 * @param {string} log ffmpeg の stderr
 * @returns {[number, number][]}
 */
export function parseSilences(log) {
  /** @type {[number, number][]} */
  const silences = [];
  let start = null;
  for (const line of String(log).split(/\r?\n/)) {
    const begin = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (begin) {
      start = Math.max(0, Number(begin[1]));
      continue;
    }
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (end && start !== null && Number.isFinite(Number(end[1]))) {
      silences.push([start, Number(end[1])]);
      start = null;
    }
  }
  // 末尾まで無音のまま終わると silence_end が出ない
  if (start !== null) silences.push([start, Infinity]);
  return silences;
}

/**
 * 無音区間の裏返し＝発話区間。0.15 秒に満たない切れ端は捨てる。
 * @param {number} duration 音声の長さ（秒）
 * @param {[number, number][]} silences
 * @returns {[number, number][]}
 */
export function invertSilence(duration, silences) {
  /** @type {[number, number][]} */
  const speech = [];
  let t = 0;
  for (const [s, e] of silences) {
    if (s > t + 0.15) speech.push([t, s]);
    t = Math.max(t, e);
  }
  if (duration > t + 0.15) speech.push([t, duration]);
  return speech;
}

/**
 * 100ms ごとの RMS（-1〜1 に正規化した振幅の二乗平均平方根）。
 * @param {Int16Array} samples 16 kHz モノラル
 */
export function rmsHops(samples) {
  const out = new Float32Array(Math.ceil(samples.length / HOP_SAMPLES));
  for (let hop = 0; hop < out.length; hop++) {
    const from = hop * HOP_SAMPLES;
    const to = Math.min(samples.length, from + HOP_SAMPLES);
    let sum = 0;
    for (let i = from; i < to; i++) sum += (samples[i] / 32768) ** 2;
    out[hop] = Math.sqrt(sum / (to - from));
  }
  return out;
}

/**
 * [a, b] 秒の中で一番静かな窓の中央の時刻。範囲に窓が無ければ null。
 * @param {Float32Array|null} rms
 * @param {number} a
 * @param {number} b
 */
export function quietest(rms, a, b) {
  if (!rms) return null;
  const i0 = Math.ceil(a / HOP);
  const i1 = Math.min(Math.floor(b / HOP), rms.length - 1);
  if (i1 <= i0 || i0 >= rms.length) return null;
  let best = i0;
  for (let i = i0 + 1; i <= i1; i++) if (rms[i] < rms[best]) best = i;
  return best * HOP + HOP / 2;
}

/**
 * max 秒を超える発話を、切り点手前の一番静かな所で順に切る。どの片も max を超えない。
 * @param {number} s
 * @param {number} e
 * @param {number} max
 * @param {Float32Array|null} rms
 * @param {[number, number][]} out
 */
export function splitSmart(s, e, max, rms, out) {
  while (e - s > max) {
    const target = s + max;
    const from = Math.max(target - SPLIT_WINDOW, s + Math.min(MIN_PIECE, max / 2));
    const found = quietest(rms, Math.max(from, s), target) ?? target;
    const cut = Math.min(target, Math.max(s + MIN_HARD_CUT, found));
    out.push([s, cut]);
    s = cut;
  }
  out.push([s, e]);
}

/**
 * @typedef {{start:number, end:number, cutStart:number, cutEnd:number}} Segment
 *   start/end は事件の時刻、cutStart/cutEnd は切り出す音声の範囲（両端の無音を少し含む）
 */

/**
 * 発話区間を送る単位にする：短すぎる区間を捨て、長い区間は静かな所で切り、
 * 元の発話の外側の端だけ無音側へ PAD 秒広げる（内側の切り点は広げない：隣の片と重なって
 * 同じ語が二度書かれないように）。発話が無ければ空（無音を送ると ASR が幻の文を作る）。
 * @param {[number, number][]} speech
 * @param {number} maxSpeech
 * @param {Float32Array|null} rms
 * @param {number} duration
 * @returns {Segment[]}
 */
export function speechSegments(speech, maxSpeech, rms, duration) {
  const raw = speech.filter(([a, b]) => b - a >= 0.2);
  /** @type {Segment[]} */
  const segments = [];
  raw.forEach(([rs, re], index) => {
    /** @type {[number, number][]} */
    const pieces = [];
    splitSmart(rs, re, maxSpeech, rms, pieces);
    const lower = index > 0 ? raw[index - 1][1] : 0;
    const upper = index + 1 < raw.length ? raw[index + 1][0] : duration;
    pieces.forEach(([s, e], i) => {
      const cutStart = i === 0 ? Math.max(0, lower, s - PAD) : s;
      const cutEnd = i === pieces.length - 1 ? Math.max(e, Math.min(upper, e + PAD)) : e;
      segments.push({ start: s, end: e, cutStart, cutEnd });
    });
  });
  return segments;
}

/**
 * 16 kHz・モノラル・16 bit の WAV の PCM 部分の位置と長さ（ffmpeg は LIST チャンクを挟むことがある）。
 * @param {Buffer} head ファイル先頭（数 KB あれば足りる）
 * @returns {{offset:number, bytes:number}}
 */
export function pcmData(head) {
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV 文件');
  let at = 12;
  while (at + 8 <= head.length) {
    const id = head.toString('ascii', at, at + 4);
    const size = head.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      const channels = head.readUInt16LE(at + 10);
      const rate = head.readUInt32LE(at + 12);
      const bits = head.readUInt16LE(at + 22);
      if (channels !== 1 || rate !== 16000 || bits !== 16) throw new Error('需要 16 kHz 单声道 16 位 WAV');
    }
    // ffmpeg がパイプへ書くと長さ欄が 0xFFFFFFFF のままになる：その場合はファイルの終わりまで
    if (id === 'data') return { offset: at + 8, bytes: size };
    at += 8 + size + (size & 1);
  }
  throw new Error('WAV 里找不到音频数据');
}

/**
 * WAV ファイルの 100ms ごとの RMS を、全体を読み込まずに流し読みで求める（1 時間で 115 MB あるため）。
 * @param {import('node:fs/promises').FileHandle} file
 * @param {{offset:number, bytes:number}} data
 */
export async function rmsOfFile(file, data) {
  const out = new Float32Array(Math.ceil(data.bytes / 2 / HOP_SAMPLES));
  const buffer = Buffer.alloc(HOP_SAMPLES * 2 * 64);
  let hop = 0;
  let sum = 0;
  let count = 0;
  for (let at = 0; at < data.bytes;) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, data.bytes - at), data.offset + at);
    if (!bytesRead) break;
    // 読み取りは常に偶数バイト（buffer も data.bytes も 2 の倍数）
    for (let i = 0; i + 1 < bytesRead; i += 2) {
      sum += (buffer.readInt16LE(i) / 32768) ** 2;
      if (++count === HOP_SAMPLES) {
        out[hop++] = Math.sqrt(sum / count);
        sum = 0;
        count = 0;
      }
    }
    at += bytesRead;
  }
  if (count) out[hop] = Math.sqrt(sum / count);
  return out;
}

/**
 * PCM に 44 バイトの WAV ヘッダを付ける（16 kHz・モノラル・16 bit）。
 * @param {Buffer} pcm
 */
export function wavFile(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
