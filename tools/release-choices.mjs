// Both release lines share a download menu; they keep their own versions and artifacts.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function assetNames(edition, tag) {
  if (!['cli', 'standalone'].includes(edition) || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error('Expected cli or standalone and a vX.Y.Z release tag');
  }
  const version = tag.slice(1);
  return [
    `course2md-${version}.zip`,
    ...(edition === 'cli' ? [`course2md-cli-bridge-${version}.zip`] : [
      `course2md-helper-${version}.zip`,
      `course2md-helper-${version}-windows.exe`,
      `course2md-helper-${version}-macos.pkg`,
      `course2md-helper-${version}-linux.run`,
    ]),
    'SHA256SUMS.txt',
  ];
}

export function selectEditions(releases) {
  const published = releases.filter((release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  return Object.fromEntries(['standalone', 'cli'].map((edition) => {
    const release = published.find((item) => assetNames(edition, item.tag_name).every((name) =>
      item.assets.some((asset) => asset.name === name && asset.state === 'uploaded' && asset.size > 0 && asset.browser_download_url)));
    if (!release) throw new Error(`No complete published ${edition} edition; refusing to publish a broken download menu`);
    return [edition, release];
  }));
}

export function choiceNotes({ standalone, cli }, body = '') {
  const link = (release, name, label) => {
    const asset = release.assets.find((item) => item.name === name);
    if (!asset) throw new Error(`Missing release asset: ${name}`);
    return `[${label}](${asset.browser_download_url})`;
  };
  const version = (release) => release.tag_name.slice(1);
  const ext = (release) => link(release, `course2md-${version(release)}.zip`, `扩展 ZIP · Extension ${release.tag_name}`);
  const installer = (os, suffix) => link(standalone, `course2md-helper-${version(standalone)}-${suffix}`, os);
  const repo = cli.html_url.split('/releases/tag/')[0];
  const menu = `<!-- edition-choices:start -->
## 选择版本 · Choose your edition

两版都有页面浮窗、字幕快取、时间戳、图片密度和自备 API。两条版本线独立更新，选一个扩展包即可。
Both keep floating notes, fast subtitles, timestamps, image controls and custom APIs. Version numbers advance independently; choose one extension ZIP.

| 版本 · Edition | 侧重 · Best for | 本机处理需要 · Local processing needs | 下载 · Download |
| --- | --- | --- | --- |
| **独立版 · Standalone ${standalone.tag_name}** | 内置阅读器与课程库 · Built-in reader and course library | Web 本机助手，无需另装 CLI · Web helper, no separate CLI | ${ext(standalone)} |
| **CLI 版 · CLI ${cli.tag_name}** | 复用 CLI 模型、配置与处理能力 · Reuse CLI models, settings and processing | course2md 2.0 CLI + 浏览器连接 · CLI + browser connection | ${ext(cli)} |

- **独立版组件 · Standalone helper:** ${installer('Windows .exe', 'windows.exe')} · ${installer('macOS .pkg', 'macos.pkg')} · ${installer('Linux .run', 'linux.run')} · ${link(standalone, `course2md-helper-${version(standalone)}.zip`, '脚本包 · Script ZIP')} · ${link(standalone, 'SHA256SUMS.txt', 'SHA-256')}. [安装说明 · Setup](${repo}/blob/${standalone.tag_name}/README.md).
- **CLI 版组件 · CLI connection:** ${link(cli, `course2md-cli-bridge-${version(cli)}.zip`, '浏览器连接 ZIP · Browser connection ZIP')} · ${link(cli, 'SHA256SUMS.txt', 'SHA-256')}. Install [course2md CLI](https://github.com/mizorewww/course2md/wiki/CLI-Guide), then [登记浏览器连接一次 · register the browser connection once](${repo}/blob/${cli.tag_name}/README.md#cli-connection).

平台字幕的纯文字笔记可直接使用扩展；转录和截图再安装所选版本的本机组件。
Text-only platform-subtitle notes need just the extension. Install your edition's local components for transcription and screenshots.
<!-- edition-choices:end -->`;
  const rest = body.replace(/<!-- edition-choices:start -->[\s\S]*?<!-- edition-choices:end -->\s*/g, '').trim();
  return `${menu}\n${rest ? `\n${rest}\n` : ''}`;
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
}

function publishedReleases() {
  return JSON.parse(gh(['api', 'repos/{owner}/{repo}/releases?per_page=100', '--paginate', '--slurp'])).flat();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const releases = publishedReleases();
  if (process.argv[2] === '--sync') {
    const editions = selectEditions(releases);
    for (const [edition, release] of Object.entries(editions)) {
      gh(['release', 'edit', release.tag_name, '--title', `course2md Web ${release.tag_name} · ${edition === 'cli' ? 'CLI' : 'Standalone'}`,
        '--notes-file', '-'], choiceNotes(editions, release.body));
      console.log(`Updated ${edition} downloads: ${release.html_url}`);
    }
  } else {
    const [edition, tag] = process.argv.slice(2);
    const repo = gh(['api', 'repos/{owner}/{repo}', '--jq', '.html_url']).trim();
    const current = {
      tag_name: tag, published_at: new Date().toISOString(), html_url: `${repo}/releases/tag/${tag}`,
      assets: assetNames(edition, tag).map((name) => ({
        name, state: 'uploaded', size: statSync(`dist/${name}`).size,
        browser_download_url: `${repo}/releases/download/${tag}/${name}`,
      })),
    };
    process.stdout.write(choiceNotes(selectEditions([current, ...releases])));
  }
}
