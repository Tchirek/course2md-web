import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectExtensionIds } from '../tools/extension-ids.mjs';

test('finds every loaded copy of the extension and ignores look-alikes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'c2md-ids-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Two copies of this extension in different folders, so they have different IDs.
  const copyA = join(root, 'checkout');
  const copyB = join(root, 'release-0.3.0');
  for (const folder of [copyA, copyB]) {
    await mkdir(folder, { recursive: true });
    await copyFile('manifest.json', join(folder, 'manifest.json'));
  }
  // An unrelated extension with a similar name but a different service worker.
  const other = join(root, 'other');
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 'manifest.json'), JSON.stringify({ name: 'course2md clone', background: { service_worker: 'bg.js' } }));

  const browser = join(root, 'Edge', 'User Data');
  const preferences = (settings) => JSON.stringify({ extensions: { settings } });
  await mkdir(join(browser, 'Default'), { recursive: true });
  await writeFile(join(browser, 'Default', 'Secure Preferences'), preferences({
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { path: copyA },
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: { path: other },
    cccccccccccccccccccccccccccccccc: { path: join(root, 'deleted-folder') },
  }));
  await mkdir(join(browser, 'Profile 2'), { recursive: true });
  await writeFile(join(browser, 'Profile 2', 'Preferences'), preferences({ dddddddddddddddddddddddddddddddd: { path: copyB } }));

  const ids = detectExtensionIds([browser, join(root, 'not-installed')]);
  assert.deepEqual(ids.sort(), ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'dddddddddddddddddddddddddddddddd']);
});
