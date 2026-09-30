import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
const ROOT = 'Q:/c2md';
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const patterns = manifest.web_accessible_resources.flatMap((w) => w.resources);
const globToRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
const all = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? all(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const exposed = all('src').filter((f) => patterns.some((p) => globToRe(p).test(f)));
const closure = new Set();
const queue = ['src/content/boot.js'];
while (queue.length) {
  const file = queue.shift();
  if (closure.has(file) || !existsSync(join(ROOT, file))) continue;
  closure.add(file);
  const text = read(file);
  for (const m of [...text.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g), ...text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm), ...text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g), ...text.matchAll(/chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g)]) {
    const spec = m[1];
    if (!/^(\.|\/|src\/)/.test(spec)) continue;
    const r = spec.startsWith('.') ? join(dirname(file), spec).replace(/\\/g, '/') : spec.replace(/^\//, '');
    if (r.endsWith('.js')) queue.push(r);
  }
}
console.log('exposed but not in closure:', exposed.filter((f) => !closure.has(f)));
