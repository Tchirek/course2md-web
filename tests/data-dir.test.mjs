import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCATION_FILE, chooseDataDir, dataDir, defaultDataDir, removeObsoleteWhisper, sharedModelTarget } from '../tools/helper-data.mjs';

/** Points the platform default at a temporary folder for the duration of fn. */
function withTempHome(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'c2md-data-'));
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME, C2MD_DATA_DIR: process.env.C2MD_DATA_DIR, HOME: process.env.HOME };
  process.env.LOCALAPPDATA = path.join(root, 'local');
  process.env.XDG_DATA_HOME = path.join(root, 'xdg');
  process.env.HOME = path.join(root, 'home');
  delete process.env.C2MD_DATA_DIR;
  try {
    fn(root);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('数据目录默认在平台位置，选定后记在默认位置并一直沿用', () => {
  withTempHome((root) => {
    assert.equal(dataDir(), defaultDataDir());
    const chosen = chooseDataDir(path.join(root, 'elsewhere'));
    assert.equal(dataDir(), chosen);
    assert.ok(existsSync(chosen));
    assert.deepEqual(JSON.parse(readFileSync(path.join(defaultDataDir(), LOCATION_FILE), 'utf8')), { dir: chosen });
    // choosing the default again leaves no record behind
    chooseDataDir(defaultDataDir());
    assert.equal(dataDir(), defaultDataDir());
    assert.equal(existsSync(path.join(defaultDataDir(), LOCATION_FILE)), false);
  });
});

test('数据目录不随磁盘剩余空间变化；记录损坏或不是绝对路径时退回默认位置', () => {
  withTempHome((root) => {
    chooseDataDir(path.join(root, 'elsewhere'));
    writeFileSync(path.join(defaultDataDir(), LOCATION_FILE), '{ broken');
    assert.equal(dataDir(), defaultDataDir());
    writeFileSync(path.join(defaultDataDir(), LOCATION_FILE), JSON.stringify({ dir: 'relative/path' }));
    assert.equal(dataDir(), defaultDataDir());
  });
});

test('C2MD_DATA_DIR 优先于记录的选择', () => {
  withTempHome((root) => {
    chooseDataDir(path.join(root, 'elsewhere'));
    process.env.C2MD_DATA_DIR = path.join(root, 'override');
    assert.equal(dataDir(), path.join(root, 'override'));
  });
});

test('数据目录移到别处时，共享模型也跟到那里；测试用的 C2MD_DATA_DIR 不影响原版配置', () => {
  withTempHome((root) => {
    assert.equal(sharedModelTarget(), null);
    const chosen = chooseDataDir(path.join(root, 'elsewhere'));
    assert.equal(sharedModelTarget(), path.join(chosen, 'models'));
    process.env.C2MD_DATA_DIR = path.join(root, 'override');
    assert.equal(sharedModelTarget(), null);
  });
});

test('只删旧版 faster-whisper 的环境与模型，与原版共用的模型和转录日志原样保留', () => {
  withTempHome((root) => {
    const chosen = chooseDataDir(path.join(root, 'elsewhere'));
    const make = (...parts) => {
      const file = path.join(...parts);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'x');
      return file;
    };
    const whisper = [
      make(chosen, 'asr', 'venv', 'Scripts', 'python.exe'),
      make(chosen, 'asr', 'constraints.txt'),
      make(chosen, 'models', 'models--Systran--faster-whisper-small', 'snapshots', 'model.bin'),
      make(chosen, 'models', '.locks', 'models--Systran--faster-whisper-small', 'a.lock'),
      make(chosen, 'models', 'verified.json'),
      make(defaultDataDir(), 'asr', 'venv', 'pyvenv.cfg'),
    ];
    const kept = [
      make(chosen, 'models', 'llama-qwen3-1.7b', 'Qwen3-ASR-1.7B-Q8_0.gguf'),
      make(chosen, 'models', '.web-verified.json'),
      make(chosen, 'asr', 'qwen-asr.log'),
    ];
    const removed = [];
    removeObsoleteWhisper((target) => removed.push(target));
    assert.ok(whisper.every((file) => !existsSync(file)), '旧版环境与模型都已删除');
    assert.ok(kept.every((file) => existsSync(file)), '共用模型与日志保留');
    assert.ok(removed.length >= 5);

    // 测试用的 C2MD_DATA_DIR：只清理那个目录，不碰默认位置
    const outside = make(defaultDataDir(), 'asr', 'venv', 'pyvenv.cfg');
    process.env.C2MD_DATA_DIR = path.join(root, 'override');
    removeObsoleteWhisper();
    assert.ok(existsSync(outside));
  });
});
