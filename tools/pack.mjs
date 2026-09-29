//! 打包发布：把扩展打成一份全平台通用的 zip。
//!
//! 为什么只有一份：浏览器扩展不区分操作系统与 CPU 架构，Windows、Linux、
//! Intel/Apple Silicon macOS 加载的是同一个包；真正分平台的只有「本机助手」
//! 的安装方式（见 README 与 release 说明），那部分不进扩展的包。
//!
//! 包内 = manifest.json + src/ 全部 + README.md。打包前先跑清单自检——
//! 引用闭包不完整就不许出门；打完再列一遍条目，确认 zip 内是正斜杠路径
//! （Windows 压缩器爱写反斜杠，部分解压器会认成转义）。

import { cpSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipName = `course2md-${version}.zip`;
const zipPath = join(DIST, zipName);

// ---------- 1. 清单自检：引用的文件都在、模块闭包可被页面取到 ----------
const check = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-manifest.mjs')], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status ?? 1);

// ---------- 2. 暂存 → 压缩 ----------
rmSync(DIST, { recursive: true, force: true });
const stage = join(DIST, 'stage');
mkdirSync(stage, { recursive: true });
cpSync(join(ROOT, 'manifest.json'), join(stage, 'manifest.json'));
cpSync(join(ROOT, 'src'), join(stage, 'src'), { recursive: true });
cpSync(join(ROOT, 'README.md'), join(stage, 'README.md'));

// Windows 自带 bsdtar（可写 zip、条目用正斜杠）；macOS 的 /usr/bin/tar 也是 bsdtar；
// Linux 的 GNU tar 写不了 zip，退回 zip 命令。
const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const packers = {
  win32: { cmd: winTar, args: ['-a', '-cf', zipPath, '-C', stage, 'manifest.json', 'src', 'README.md'], list: ['-tf', zipPath] },
  darwin: { cmd: '/usr/bin/tar', args: ['-a', '-cf', zipPath, '-C', stage, 'manifest.json', 'src', 'README.md'], list: ['-tf', zipPath] },
};
const packer = packers[process.platform] ?? { cmd: 'zip', args: ['-r', '-q', zipPath, 'manifest.json', 'src', 'README.md'], list: null, cwd: stage };

const packed = spawnSync(packer.cmd, packer.args, { cwd: packer.cwd ?? ROOT, stdio: 'inherit' });
if (packed.status !== 0) {
  console.error(`打包失败：${packer.cmd}`);
  process.exit(packed.status ?? 1);
}

// ---------- 3. 验包：条目数对得上、没有反斜杠 ----------
let entries = [];
if (packer.list) {
  const listed = spawnSync(packer.cmd, packer.list, { encoding: 'utf8' });
  entries = listed.stdout.split(/\r?\n/).filter(Boolean);
} else {
  const listed = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  if (listed.status === 0) entries = listed.stdout.split(/\r?\n/).filter(Boolean);
}
const fileEntries = entries.filter((name) => !name.endsWith('/'));
const expected = ['manifest.json', 'README.md', ...allFiles(join(ROOT, 'src'), 'src')];
const bad = fileEntries.filter((name) => name.includes('\\'));
if (bad.length || fileEntries.length !== expected.length) {
  console.error(`包内容不对：条目 ${fileEntries.length}/${expected.length}${bad.length ? `，反斜杠路径 ${bad.length} 个` : ''}`);
  process.exit(1);
}

// ---------- 4. 校验和 ----------
const hash = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(join(DIST, 'SHA256SUMS.txt'), `${hash}  ${zipName}\n`);

rmSync(stage, { recursive: true, force: true });
console.log(`\n${zipName}：${expected.length} 个文件，${Math.round(statSync(zipPath).size / 102.4) / 10} KB`);
console.log(`sha256: ${hash}`);
console.log(`产物在 dist/：${zipName}、SHA256SUMS.txt`);

function allFiles(dir, prefix) {
  const out = [];
  for (const name of readdirSorted(dir)) {
    const abs = join(dir, name);
    const rel = `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) out.push(...allFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

function readdirSorted(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
