import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCATION_FILE, chooseDataDir, dataDir, defaultDataDir } from '../tools/helper-data.mjs';

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
