//! 打包发布：产出两个 zip。
//!
//! 1. course2md-<ver>.zip —— 扩展本体。浏览器扩展不区分操作系统与 CPU 架构，
//!    Windows、Linux、Intel/Apple Silicon macOS 加载的是同一个包。
//! 2. course2md-helper-<ver>.zip —— 本机助手：提取服务、原生宿主、安装与检查
//!    脚本。纯 Node/Python 实现，同样全平台一份；目录保持 tools/ 前缀，
//!    安装脚本里的相对路径才能原样工作。
//!
//! 打包前先跑完整检查（清单、单元测试、布局断言，与 npm run check 相同），任何一项
//! 不过都不产出发布包；打完再列一遍条目，确认 zip 内是正斜杠路径
//! （Windows 压缩器爱写反斜杠，部分解压器会认成转义）。

import { cpSync, mkdirSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
// main への push ごとの自動リリースでは、CI が決めた版（例 0.4.3）で包む。リポジトリの manifest は書き換えない
const version = releaseVersion(process.env.C2MD_VERSION, manifest.version);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 助手运行/安装/自检所需的全部文件（check-local-asr.mjs 依赖扩展源码，不在内）。 */
const HELPER_FILES = [
  '安装本机助手.cmd',
  'tools/install-helper.ps1',
  'tools/engine-pins.json',
  'tools/library.py',
  'tools/fast-asr-server.mjs',
  'tools/bilibili-audio.mjs',
  'tools/speech-segments.mjs',
  'tools/launch-local-polish.mjs',
  'tools/qwen-asr.py',
  'tools/runtime_download.py',
  'tools/local-polish.py',
  'tools/service_lifecycle.py',
  'tools/pins.py',
  'tools/runtime-pins.json',
  'tools/install-local-asr.mjs',
  'tools/uninstall-local-asr.mjs',
  'tools/native-host.mjs',
  'tools/helper-data.mjs',
  'tools/services.mjs',
  'tools/install-lock.mjs',
  'tools/pip-install.mjs',
  'tools/extension-ids.mjs',
  'tools/host-registration.mjs',
  'tools/native-helper.cs',
  'tools/check-native-helper.mjs',
  'tools/check-local-polish.mjs',
];
/** 两个包都附带：说明、本项目许可与第三方许可声明。 */
const LEGAL_FILES = ['README.md', 'README.zh-Hant.md', 'README.en.md', 'README.ja.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const HELPER_SCRIPTS = ['fast-asr', 'local:install', 'local:uninstall', 'local:check-host', 'check:local-polish'];

// ---------- 0. 完整检查：测试不过就不许出门 ----------
// 以前只跑清单自检，单元测试和布局断言失败也照样能打出发布包
// npm's own CLI path is available under npm run; execute it directly without a Windows shell.
const npmCli = process.env.npm_execpath || (process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null);
const check = npmCli
  ? spawnSync(process.execPath, [npmCli, 'run', 'check'], { cwd: ROOT, stdio: 'inherit', windowsHide: true })
  : spawnSync('npm', ['run', 'check'], { cwd: ROOT, stdio: 'inherit' });
if (check.status !== 0) {
  console.error('检查没有全部通过，不打包。');
  process.exit(check.status || 1);
}

rmSync(DIST, { recursive: true, force: true });

const artifacts = [];

// ---------- 1. 扩展 zip ----------
artifacts.push(await makeZip(`course2md-${version}.zip`, join(DIST, 'stage-ext'), async (stage) => {
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  cpSync(join(ROOT, 'src'), join(stage, 'src'), { recursive: true });
  for (const file of LEGAL_FILES) cpSync(join(ROOT, file), join(stage, file));
  return ['manifest.json', ...LEGAL_FILES, ...allFiles(join(ROOT, 'src'), 'src')];
}));

// ---------- 2. 本机助手 zip ----------
artifacts.push(await makeZip(`course2md-helper-${version}.zip`, join(DIST, 'stage-helper'), async (stage) => {
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: pkg.name,
    version,
    private: true,
    type: 'module',
    license: pkg.license,
    engines: pkg.engines,
    scripts: Object.fromEntries(HELPER_SCRIPTS.map((key) => {
      if (!pkg.scripts?.[key]) throw new Error(`package.json 缺少脚本 ${key}`);
      return [key, pkg.scripts[key]];
    })),
  }, null, 2) + '\n');
  for (const file of LEGAL_FILES) cpSync(join(ROOT, file), join(stage, file));
  for (const rel of HELPER_FILES) {
    mkdirSync(dirname(join(stage, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(stage, rel));
  }
  return ['package.json', ...LEGAL_FILES, ...HELPER_FILES];
}));

// ---------- 3. 校验和 ----------
const sums = artifacts.map(({ name, zipPath }) =>
  `${createHash('sha256').update(readFileSync(zipPath)).digest('hex')}  ${name}`).join('\n') + '\n';
writeFileSync(join(DIST, 'SHA256SUMS.txt'), sums);

for (const { name, files, zipPath } of artifacts) {
  console.log(`${name}：${files.length} 个文件，${Math.round(statSync(zipPath).size / 102.4) / 10} KB`);
}
console.log('sha256:');
console.log(sums.trimEnd());
console.log('产物在 dist/');

async function makeZip(name, stage, populate) {
  mkdirSync(stage, { recursive: true });
  const expected = await populate(stage);
  const zipPath = join(DIST, name);
  // Windows 自带 bsdtar（可写 zip、条目用正斜杠）；macOS 的 /usr/bin/tar 也是 bsdtar；
  // Linux 的 GNU tar 写不了 zip，退回 zip 命令。
  const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const packers = {
    win32: { cmd: winTar, cwd: stage },
    darwin: { cmd: '/usr/bin/tar', cwd: stage },
  };
  const packer = packers[process.platform] ?? { cmd: 'zip', cwd: stage };
  const args = packer.cmd.endsWith('zip')
    ? ['-r', '-q', zipPath, ...expected]
    : ['-a', '-cf', zipPath, '-C', stage, ...expected];
  const packed = spawnSync(packer.cmd, args, { stdio: 'inherit' });
  if (packed.status !== 0) {
    console.error(`打包失败：${packer.cmd}`);
    process.exit(packed.status ?? 1);
  }
  // 验包：条目数对得上、没有反斜杠
  // zip 自体は一覧を出せないので unzip -Z1（zipinfo）を使う。bsdtar は -tf
  const [lister, listArgs] = packer.cmd.endsWith('zip') ? ['unzip', ['-Z1', zipPath]] : [packer.cmd, ['-tf', zipPath]];
  const listed = spawnSync(lister, listArgs, { encoding: 'utf8' });
  const entries = (listed.stdout ?? '').split(/\r?\n/).filter(Boolean);
  const fileEntries = entries.filter((entry) => !entry.endsWith('/'));
  const bad = fileEntries.filter((entry) => entry.includes('\\'));
  if (bad.length || fileEntries.length !== expected.length) {
    console.error(`${name} 包内容不对：条目 ${fileEntries.length}/${expected.length}${bad.length ? `，反斜杠路径 ${bad.length} 个` : ''}`);
    process.exit(1);
  }
  rmSync(stage, { recursive: true, force: true });
  return { name, zipPath, files: expected };
}

function allFiles(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    const rel = `${prefix}/${entry}`;
    if (statSync(abs).isDirectory()) out.push(...allFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** 包む版。指定がなければ manifest の版。指定は Chrome の版の形式で、manifest の版より古くてはならない。 */
function releaseVersion(requested, base) {
  if (!requested) return base;
  if (!/^\d+(\.\d+){0,3}$/.test(requested)) throw new Error(`C2MD_VERSION の形式が不正：${requested}`);
  const parts = (value) => value.split('.').map(Number);
  const [a, b] = [parts(requested), parts(base)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      if ((a[i] ?? 0) < (b[i] ?? 0)) throw new Error(`C2MD_VERSION ${requested} が manifest の ${base} より古い`);
      break;
    }
  }
  return requested;
}
