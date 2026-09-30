import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('WAR は必要な資源だけを公開し、広すぎる glob と欠落を拒む', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c2md-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync('src', join(root, 'src'), { recursive: true });
  const original = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const check = (edit) => {
    const manifest = structuredClone(original);
    edit(manifest.web_accessible_resources[0]);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    return spawnSync(process.execPath, ['tools/check-manifest.mjs', root], { encoding: 'utf8' });
  };
  assert.equal(check(() => {}).status, 0);
  assert.match(check((war) => war.resources.push('src/core/*.js')).stdout, /用不到的 src\/core\/build.js/);
  assert.match(check((war) => { war.resources = war.resources.filter((f) => f !== 'src/ui/panel.css'); }).stdout, /覆盖不到：src\/ui\/panel.css/);
  assert.match(check((war) => war.resources.push('src/ui/freshness.js')).stdout, /用不到的 src\/ui\/freshness.js/);
});
