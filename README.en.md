<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/banner-dark.svg">
  <img alt="course2md: lecture videos → illustrated notes" src="docs/media/banner-light.svg" width="100%">
</picture>

[简体中文](README.md) · [正體中文](README.zh-Hant.md) · **English** · [日本語](README.ja.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Tchirek/course2md-web/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white)](https://github.com/Tchirek/course2md-web/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Tchirek/course2md-web?style=flat-square&color=246a50)](https://github.com/Tchirek/course2md-web/releases/latest)
[![License](https://img.shields.io/github/license/Tchirek/course2md-web?style=flat-square&color=246a50)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-246a50?style=flat-square&logo=googlechrome&logoColor=white)
![Chrome / Edge 116+](https://img.shields.io/badge/Chrome%20%2F%20Edge-116%2B-246a50?style=flat-square&logo=microsoftedge&logoColor=white)
![Zero build](https://img.shields.io/badge/build-zero--step-246a50?style=flat-square)
![tsc --checkJs](https://img.shields.io/badge/types-tsc%20----checkJs-3178c6?style=flat-square&logo=typescript&logoColor=white)
![CLI ASR](https://img.shields.io/badge/ASR-CLI-246a50?style=flat-square)
[![Last commit](https://img.shields.io/github/last-commit/Tchirek/course2md-web?style=flat-square&color=246a50)](https://github.com/Tchirek/course2md-web/commits/main)

</div>

# course2md — browser extension

Turns a video page into lecture notes **with slides, timestamps, click-to-seek and optional proofreading**. The illustrated download contains `course.md` plus the screenshots in `frames/`.

<p align="center">
  <img src="docs/media/demo-launch.gif" alt="Click the ↗ after the video title: the panel shows the text first, then fills in the slide screenshots" width="880">
  <br>
  <sub>Click the ↗ after the title: text appears within seconds, screenshots follow (the wait for screenshots is fast-forwarded)</sub>
</p>

> **Note:** the extension's interface is currently in Simplified Chinese. This README quotes the on-screen labels in Chinese with a translation, e.g. 「生成笔记」 (Generate notes).

course2md Web provides the floating reader, subtitle fast path and browser note controls; [course2md CLI](https://github.com/mizorewww/course2md) handles transcription and screenshots. Text-only platform-subtitle notes work directly in the browser.

Main continues from 0.4.5. The 0.5.0–0.7.x standalone helper, reader and library remain on [legacy/standalone-helper](https://github.com/Tchirek/course2md-web/tree/legacy/standalone-helper).

The interface and design choices follow [yetone/kill-ai-slop](https://github.com/yetone/kill-ai-slop).

---

## What it does

Open a video on YouTube or Bilibili, click the extension icon, pick an image density and click 「生成笔记」 (Generate notes). The popup closes and a floating panel shows progress; once transcription is done the text appears first and the screenshots follow. Drag the panel's header to move it and its bottom-right corner to resize it; drag it to the right edge of the screen and it docks as a full-height sidebar.

A faster way in: there is a ↗ after the video title. One click starts right away. That run prefers platform subtitles (falling back to the configured transcription service when there are none) and keeps the image density you used last; automatic generation started this way keeps doing the same when you switch videos.

- The floating panel shows video screenshots and the spoken text, grouped by what is on screen;
- Click a timestamp to jump to that moment in the video;
- 「复制 Markdown」 (Copy Markdown) copies the text version; the illustrated download saves `course.md` and `frames/slide_*.jpg` in one folder;
- Copy and download are clickable while generation is still running: the buttons become dashed 「完成后复制」 / 「完成后下载」 (copy / download when done) and fire the moment everything — screenshots and polishing included — is finished; click again to cancel.
- If the extension's code was updated on disk but the extension was not reloaded, a run started from the page first reloads the extension, refreshes the page and then carries on.

<table>
  <tr>
    <th width="50%">Copy or download while it is still generating: runs the moment it is done</th>
    <th width="50%">Switch image density any time: none / few / default / many</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/demo-deferred.gif" alt="Clicking copy and download during generation turns the buttons into dashed 'copy when done' and 'download when done'; they show 'copied' and 'saved' when it finishes"></td>
    <td align="center"><img src="docs/media/demo-density.gif" alt="Switching the image density in the panel"></td>
  </tr>
</table>

### The notes it produces

The illustrated download is one folder:

```text
<video title>/
├── course.md
└── frames/
    ├── slide_0001.jpg
    ├── slide_0002.jpg
    └── …
```

The start of `course.md` (a real excerpt; long paragraphs are cut short). Metadata labels are written in Chinese:

```markdown
# 2. Branching and Iteration

- 作者：MIT OpenCourseWare
- 时长：43:30
- 来源：[https://www.youtube.com/watch?v=0jljZRnHwOI](https://www.youtube.com/watch?v=0jljZRnHwOI)
- 文字来源：平台字幕 · 97 段
- 由 course2md-web 生成

---

## [00:00](https://www.youtube.com/watch?v=0jljZRnHwOI&t=0)

![视频 00:00 的截图](frames/slide_0001.jpg)

[00:00](https://www.youtube.com/watch?v=0jljZRnHwOI&t=0) The following content is provided under a Creative Commons license. …

[00:31](https://www.youtube.com/watch?v=0jljZRnHwOI&t=31) PROFESSOR: All right. Let's get started, everyone. So, good afternoon. Welcome to the second lecture of 60001 and also of 600. …

![视频 01:00 的截图](frames/slide_0002.jpg)

[01:00](https://www.youtube.com/watch?v=0jljZRnHwOI&t=60) And I think the main takeaway from the last lecture is really that a computer only does what it is told, right? …
```

## Display and processing

Drag the panel to the right edge of the screen to dock it as a full-height sidebar; its colours follow the system's light or dark mode:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/panel-dark.png">
  <img alt="The panel docked as a full-height sidebar: the lecture plays on the left, the notes with screenshots and timestamps are on the right" src="docs/media/panel-light.png">
</picture>

| Option | Default | Behaviour |
| --- | --- | --- |
| **显示讲述时刻** (Show timestamps) | On | Marks each paragraph with `mm:ss`; click to seek |
| **显示图片** (Show images) | Default | None / few / default / many; only frames that changed are kept, "many" at most one every 10 seconds |
| **Polish text** | Off | Light / standard / deep; CLI settings or custom API, with original text retained |

After you have clicked 「生成笔记」 once, switching videos generates automatically; closing the panel stops that.

With timestamps hidden, the text shows no seek buttons; unpolished transcript paragraphs still get sentence-final punctuation.

## Where the text comes from

### Platform subtitles (default, fastest)

YouTube: human-made subtitles first, then auto-generated ones. Bilibili: CC subtitles from `player/wbi/v2` (`player/v2` often returns another video's subtitles, so it is not used).
Auto subtitles that roll line by line (such as YouTube's auto-caption VTT, where every cue repeats the previous cue's last line) are collapsed by whole lines; two sentences in hand-made subtitles that merely meet end to end are never joined.
YouTube subtitles need an access token issued by the player; the extension takes it from the player's own subtitle request, and if there is none it has the player load subtitles once and then restores the subtitle toggle. While a pre-roll ad plays, it waits for the ad to finish.
When platform subtitles are unavailable (none exist, login required, the API fails, the subtitles don't match the video, …) that run switches to the configured transcription service with a one-line notice in the panel; the 「文字来源」 (text source) setting is left unchanged.

### CLI transcription and screenshots

<a id="cli-connection"></a>

Install [course2md 2.0 CLI](https://github.com/mizorewww/course2md/wiki/CLI-Guide), verified against v2.0.0-rc.6, and run `course2md doctor`. Online media needs `yt-dlp`; media processing needs `ffmpeg` / `ffprobe`. GPU / CPU recognition needs `llama-server`; Apple Silicon can use CoreML and supported Intel devices can use NPU. The CLI prepares and downloads models on demand.

Browsers cannot launch local commands directly, and the current CLI has no browser transport. One small standard-library script connects them. Load the extension, install Python 3.11+ and Node.js 22+, then register once from this checkout or `course2md-cli-bridge-<version>.zip`:

```sh
node tools/install-local-asr.mjs
```

Registration detects extension IDs and installs stable transport files for Chrome / Edge. Node is needed only for registration; normal use wakes Python through the browser and runs the CLI. Windows, macOS and Linux share the same protocol. Nothing is added to login startup. 「使用 CLI」 checks the connection and selects CLI transcription; `cli` is a settings marker, not an HTTP endpoint.

The CLI is located through PATH, the application's `bin/` directory or `C2MD_UPSTREAM_EXE`. It uses `course2md/config.toml` under `%APPDATA%` on Windows and `$XDG_CONFIG_HOME` or `~/.config` elsewhere. The CLI owns model locations, backend selection and service authentication. Web does not rewrite that configuration or remove shared models and courses. An API transcription provider sends audio to that configured API.

Custom loopback OpenAI transcription endpoints still support browser offline decoding and player recording as fallbacks. CLI failures show their cause directly.

Screenshots retain the CLI's actual timestamps. Density switches filter one cached catalogue without moving paragraphs. Bilibili browser cookies are passed in a private temporary snapshot; YouTube downloads use the CLI's own supported authentication because its protocol cannot receive browser cookie snapshots.

`npm run local:check-host` checks registration and cold starts. `npm run check:cli` exercises the real CLI with short media and loopback test services, without large model downloads. Uninstall with `npm run local:uninstall`; `-- --purge` additionally removes only transport files and temporary jobs. Shared models, CLI settings and course libraries remain intact.

## Setting up polishing

「CLI 配置」 uses the model, endpoint and login configured in course2md, including Ollama / Codex. Configure it with `course2md llm setup`. 「自备 API」 keeps browser-managed OpenAI-compatible settings; keys stay in local storage and are not synced. 「授权访问此地址」 grants access to that endpoint.

Light / standard / deep polishing, custom instructions, the glossary and preceding read-only context still apply to each Web task. Browser API results stream by paragraph; CLI results arrive by chunk. After three custom API failures, the CLI configuration can handle the fallback. The CLI owns its own retries so paid requests are not multiplied. Original text remains available, including failed chunks.

### Why "send in chunks"

Not sentence by sentence, not the whole transcript, but chunks cut at **paragraph boundaries** (20 paragraphs / 1,200 characters by default), sent concurrently:

- Sentence by sentence: the model sees no context, can't fix sentence breaks, and an hour-long lecture needs thousands of requests.
- Whole transcript: exceeds the context, a failure halfway wastes everything, and long outputs drift.
- In chunks: each chunk is consecutive whole paragraphs, chunks run in parallel and don't affect each other. Each chunk also carries **the last sentence of the previous chunk**
  as read-only context, so the text stays coherent across chunk boundaries.

Every chunk must return **item by item, by id**; if the ids don't match, the whole chunk keeps the original text. The worst case is "this part wasn't polished",
never "the text is misaligned".

Turning off 「润色文本」 shows the original immediately — it is always kept, so viewing it needs no new model request.

## Installation

Not in the stores yet. Use "Load unpacked":

1. Open `chrome://extensions` (`edge://extensions` in Edge) and switch on **Developer mode** at the top right;
2. Click **Load unpacked** and choose this repository folder;
3. Open a video on YouTube or Bilibili and click the icon in the toolbar.

Requires Chrome/Edge 116 or later.

**Supported sites**: YouTube (`/watch`), Bilibili (`/video/`), and any page with a `<video>`
element (the latter needs one permission click in the popup). Local video files opened directly in the browser work too — that is exactly
course2md's "local recording" case.

## Development

Native ESM, no build step.

```sh
npm ci
npm run lint         # manifest and strict types
npm test             # browser logic, streaming, auth and lifetimes
npm run check:cli    # real CLI integration
npm run check:layout # headless Chrome layout and scroll anchoring
npm run check        # complete gate
npm run pack         # checked extension, transport and SHA256SUMS
npm run shots
npm run serve
```

CLI checks require media tools. Without an explicitly selected CLI, the check downloads an official binary pinned by SHA-256. CI exercises Windows, macOS and Linux, then publishes the checked artifacts. The transport uses Python's standard library: no pip, virtual environment or independent model downloader.

See [DESIGN.md](DESIGN.md) for the ownership boundaries and UI decisions.

## Known limits

- Platform subtitle interfaces can change. In-browser WebGPU transcription is not implemented.
- CLI processing requires the local CLI and its media / inference dependencies. Browser registration is still required once.
- The CLI does not stream individual transcript sentences; saved checkpoints supply partial text, and polishing returns by chunk.
- Illustrated export needs downloadable media. DRM media is unsupported; custom-endpoint recording fallbacks follow playback speed.
- The standalone reader, shared-library browser and native installers remain on `legacy/standalone-helper`. Main preserves the 0.4.5 browser note workflow.

## License

MIT; the full text is in `LICENSE`. Third-party components (shipped in the package and downloaded at run time) and their licences are listed in `THIRD_PARTY_NOTICES.md`.
The design tokens come from kill-ai-slop (Apache-2.0) with their values unchanged; the source is credited in
the comments of `src/ui/tokens.css`. Traditional/Simplified conversion uses opencc-js, whose licence file ships in `src/vendor/`.

The GIFs and screenshots in this README were all recorded by `npm run media` with this extension on real YouTube pages; everything on the page is a real result generated on the spot. The cursor and the camera zooms in the GIFs are composited afterwards from the real pointer positions and timings.
The demo lecture is MIT OpenCourseWare's *6.0001 Introduction to Computer Science and Programming in Python* (Fall 2016, Dr. Ana Bell),
used under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
The YouTube and bilibili logos in the banner come from Wikimedia Commons (public domain) and only indicate the supported sites; they are trademarks of their respective owners.
