import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetNames, selectEditions, choiceNotes } from '../tools/release-choices.mjs';

test('each release offers both complete editions and preserves its changelog when refreshed', () => {
  const release = (edition, tag, published_at) => ({
    tag_name: tag, published_at, html_url: `https://github.com/example/web/releases/tag/${tag}`,
    assets: assetNames(edition, tag).map((name) => ({
      name, size: 10, state: 'uploaded', browser_download_url: `https://github.com/example/web/releases/download/${tag}/${name}`,
    })),
  });
  const standalone = release('standalone', 'v0.7.3', '2026-10-02T10:00:00Z');
  const cli = release('cli', 'v0.4.7', '2026-10-02T11:00:00Z');
  const partial = release('standalone', 'v0.7.4', '2026-10-02T12:00:00Z');
  partial.assets.find((asset) => asset.name.endsWith('-macos.pkg')).state = 'new';
  const choices = selectEditions([
    { ...release('cli', 'v0.4.9', '2026-10-02T13:00:00Z'), draft: true },
    { ...release('standalone', 'v0.7.5', '2026-10-02T13:00:00Z'), prerelease: true },
    partial, standalone, cli, release('cli', 'v0.4.6', '2026-10-01T11:00:00Z'),
  ]);
  assert.deepEqual(choices, { standalone, cli });
  assert.throws(() => selectEditions([cli, partial]), /No complete published standalone/);
  assert.throws(() => assetNames('cli', '../v0.4.7'), /release tag/);
  assert.throws(() => assetNames('other', 'v0.4.7'), /cli or standalone/);
  const changelog = '**Full Changelog**: https://github.com/example/web/compare/v0.4.6...v0.4.7';
  const notes = choiceNotes(choices, changelog);
  for (const edition of [standalone, cli]) {
    for (const asset of edition.assets) assert.ok(notes.includes(`](${asset.browser_download_url})`), asset.name);
  }
  assert.ok(notes.includes('CLI v0.4.7'));
  assert.ok(notes.includes('Standalone v0.7.3'));
  assert.ok(notes.endsWith(`${changelog}\n`));
  assert.equal(choiceNotes(choices, notes), notes);
  assert.equal(notes.match(/edition-choices:start/g).length, 1);
  assert.ok(!notes.includes('原版'));
});
