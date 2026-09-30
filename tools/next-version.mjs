// main への push ごとに出すリリースの版を決める（CI から呼ぶ）。
//
// manifest の版がまだ出ていなければその版。出ていれば、同じ「主.副」の中で出した最大の
// 修正番号に 1 を足す（0.4.0 → 0.4.1 → 0.4.2 …）。manifest を手で上げればそこから始まる。
// リポジトリの manifest は書き換えない（CI が main へ書き戻すと push がまた走る）。
//
//   node tools/next-version.mjs     → 例 0.4.3（git の tag を見る）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} base manifest の版（x.y.z）
 * @param {string[]} tags 既存の tag（v0.4.0 など）
 */
export function nextVersion(base, tags) {
  const released = new Set(tags.map((tag) => tag.replace(/^v/, '')));
  if (!released.has(base)) return base;
  const [major, minor] = base.split('.');
  const prefix = `${major}.${minor}.`;
  const patches = [...released]
    .filter((version) => version.startsWith(prefix) && /^\d+$/.test(version.slice(prefix.length)))
    .map((version) => Number(version.slice(prefix.length)));
  return `${prefix}${Math.max(...patches) + 1}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  process.stdout.write(`${nextVersion(manifest.version, tags)}\n`);
}
