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
![Local-first ASR](https://img.shields.io/badge/ASR-local--first-246a50?style=flat-square)
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

This is the browser edition of [mizorewww/course2md](https://github.com/mizorewww/course2md):
it brings "video → illustrated notes" into the browser. Platform subtitles and plain videos the browser can read need no external tools;
fast audio extraction on YouTube and Bilibili can optionally use `yt-dlp` and `ffmpeg`. The text can come from **platform subtitles** or from **a local speech model you run yourself**.

The interface and design choices follow [yetone/kill-ai-slop](https://github.com/yetone/kill-ai-slop).

---

## What it does

Open a video on YouTube or Bilibili, click the extension icon, pick an image density and click 「生成笔记」 (Generate notes). The popup closes and a floating panel shows progress; once transcription is done the text appears first and the screenshots follow. Drag the panel's header to move it and its bottom-right corner to resize it; drag it to the right edge of the screen and it docks as a full-height sidebar.

A faster way in: there is a ↗ after the video title. One click starts right away. That run prefers platform subtitles (falling back to local transcription automatically when there are none) and keeps the image density you used last; automatic generation started this way keeps doing the same when you switch videos.

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
| **显示图片** (Show images) | Default | None / few / default / many; "many" keeps at most one changed frame every 10 seconds |
| **润色文本** (Polish text) | Off | Light / standard / thorough; "standard" keeps the original prompt; if your own LLM fails it falls back to the local FireRedPunc + Qwen automatically |

After you have clicked 「生成笔记」 once, switching videos generates automatically; closing the panel stops that.

With timestamps hidden, the text shows no seek buttons; unpolished transcript paragraphs still get sentence-final punctuation.

## Where the text comes from

### Platform subtitles (default, fastest)

YouTube: human-made subtitles first, then auto-generated ones. Bilibili: CC subtitles from `player/wbi/v2` (`player/v2` often returns another video's subtitles, so it is not used).
The rolling-window repetition of auto subtitles (the same sentence repeated across overlapping cues) is merged away.
YouTube subtitles need an access token issued by the player; the extension takes it from the player's own subtitle request, and if there is none it has the player load subtitles once and then restores the subtitle toggle. While a pre-roll ad plays, it waits for the ad to finish.
When platform subtitles are unavailable (none exist, login required, the API fails, the subtitles don't match the video, …) that run switches to local transcription automatically with a one-line notice in the panel; the 「文字来源」 (text source) setting is left unchanged.

### Local transcription

The preferred path is the local extraction service, which downloads and processes the streamed audio directly; short videos the browser can read directly (up to 3 minutes and 24 MiB) are decoded offline in the browser. Neither fast path waits for the player to play through. Audio is cut into 30-second chunks and sent to the local ASR service you configure.
When a YouTube or Bilibili download fails, the local helper retries with your current browser login for that site. The extension sends that site's cookies only to the local helper on `127.0.0.1`; the helper hands them to `yt-dlp` and deletes the temporary files when the job ends. Edge asks for the added site-cookie permission after the extension updates.

Run once in the project folder (Windows / macOS / Linux alike):

```sh
npm run local:install
```

It installs the Python `faster-whisper` runtime (if missing), registers the lightweight local helper as a native messaging host (which is how the extension wakes it up) and makes it start at login. Windows uses the registry and a compiled exe host; macOS / Linux write the browser's `NativeMessagingHosts` folder and start at login via LaunchAgent and XDG autostart respectively. The installer finds this extension among those loaded in Edge / Chrome (an unpacked extension's ID depends on its folder) and allows only those to call the helper, so load the extension in the browser before running it; you can also pass the ID: `node tools/install-local-asr.mjs <extension ID>`.
With local transcription selected, the helper starts the service when a job begins; the button on the settings page starts it by hand too. The local transcription and polishing models exit and free their memory after 10 minutes without work (tunable with the `C2MD_IDLE_SECONDS` environment variable) and reload the next time they are needed. The first time, if the multilingual `small`
model is missing, it is downloaded from Hugging Face; the button shows downloading, loading and ready,
and fills in the transcription address and model name. Requires Python 3, Node.js 22 and `ffmpeg`; fast
extraction on YouTube and Bilibili also needs `yt-dlp`. Installing once is enough: after later code updates the helper repairs an outdated host registration when it starts,
so there is nothing to re-run; only moving the project folder needs a reinstall. To uninstall run `npm run local:uninstall` (add `-- --purge` to delete the downloaded models too).
The local helper listens only on `127.0.0.1`, and every request except the health check needs an access token; the token is handed only to this extension over native messaging,
so other extensions and web pages on the machine cannot use the helper to read local files. Models and runtimes downloaded at run time are pinned to a version and SHA-256
(`tools/runtime-pins.json`) and used only after they verify.
The installer ends by starting the helper through the host it just registered and reports an error on the spot if the host doesn't work. When the extension can't wake the helper it says which link broke (not registered, extension ID mismatch, broken Node or helper path, …).
`npm run local:check-host` checks that the browser can find the host and that the host can start the service from scratch (by default for every copy loaded in the browser; append `-- <extension ID>` for one), and `npm run local:check` checks that the local service really accepts audio.

You can also connect an OpenAI-compatible ASR service you already run, for example either of:

```sh
# whisper.cpp (port 8080 by default; the path is exactly /v1/audio/transcriptions)
./server -m models/ggml-base.bin

# faster-whisper-server (port 8000 by default)
faster-whisper-server --model large-v3
```

Then, in the settings page under 「本地模型转录」 (local transcription), fill in the service address and model name and click 「测试连接」 (Test connection) and 「授权访问此地址」 (Allow access to this address).

Without the login-started helper you can also run the extraction service by hand:

```sh
npm run fast-asr
```

It listens only on `127.0.0.1:8766`, fetches network audio with `yt-dlp` or reads local files directly, cuts it with `ffmpeg` and calls the local ASR configured above. When Bilibili's default CDN fails it tries a backup route. Short media the browser can read directly doesn't need it.
YouTube's JavaScript challenge is solved with the Node.js runtime you already have; Node.js 22 or later is required.

**Fallbacks for restricted media:**

- If both local extraction and direct reading fail on YouTube or Bilibili, the reason is shown and the run stops — it no longer falls back to recording. Only other media that can't be extracted quickly is recorded from the player; then an hour-long lecture takes at least an hour, and **the tab must stay open** meanwhile.
- While recording, the video really plays; its sound is turned down very low but not muted (a muted element records silence).
- There is a gap of about 40 ms at chunk boundaries, so in extreme cases half a word may be lost. This keeps every chunk independently decodable.
- When the service returns `verbose_json`, timestamps are accurate to the sentence; when it returns only plain text, they fall back to chunk level.

## Setting up polishing

The settings page switches the polishing model between 「本机」 (local) and 「自定义」 (custom). Older settings keep using the remote model already filled in; with no remote model, ticking 「润色文本」 starts the local [FireRedPunc](https://huggingface.co/FireRedTeam/FireRedPunc) and [Qwen3.5-2B, Q4 quantised](https://huggingface.co/SoAIHQ/Qwen3.5-2B-GGUF); the models are downloaded on first use. Machines with 8 GB of VRAM polish one chunk at a time so the transcription model keeps its memory.

Any OpenAI-compatible `/chat/completions` endpoint works as well.

On the settings page fill in the service address (up to `/v1`), the API key (leave empty for local services) and the model name.
Then click 「授权访问此地址」 — OpenAI-compatible endpoints almost never send CORS headers, and without this step the browser
blocks the requests. The key lives only in the browser's local storage and is **not synced**.

Two optional fields are well worth filling in:

- **术语表 (Glossary)**: one entry per line. Proper nouns are always what homophones get wrong most; one line fixes them.
- **自定义校对指令 (Custom proofreading instructions)**: leave empty for the built-in ones. The output-format constraints are always appended by the extension and cannot be changed.

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

Zero build: no bundler, no build output. Content scripts load ESM with dynamic `import()`.

```sh
npm run check        # manifest self-check + type check + unit tests + layout assertions, all at once (same as CI)
npm test             # unit tests only (pure logic, node --test)
npm run check:manifest # manifest self-check: referenced files exist, the module closure is reachable from pages, permissions line up
npm run typecheck    # tsc --checkJs over src/ (the code stays JS, zero build)
npm run check:layout # geometry assertions only: panel layout, button fills, no horizontal overflow
npm run check:sites  # run the real extension on real YouTube / Bilibili pages (needs network, not in CI)
npm run check:image  # check the four image densities against a real video with three scene changes
npm run shots        # screenshots of every state → tools/shots/
npm run pack         # runs the full check first, and only then writes the two release packages to dist/
npm run media        # record the README demos with this extension on real YouTube pages → docs/media/
npm run icons        # regenerate the extension icons (own rasteriser + own PNG encoder, no native deps)
npm run serve        # self-test server: http://127.0.0.1:8787/tools/selftest.html
```

Everything in `tools/` is for development only and never runs in the product. The self-test bench needs
`tools/chrome-mock.js` because Chrome 137 removed `--load-extension`: taking screenshots in
Chrome means putting a stand-in under `chrome.*` — the product code has no back doors opened for screenshots.

`npm run check:manifest` deserves a word: a wrong path in the manifest makes Chrome **silently disable**
just that part; and modules that content scripts load with `import(chrome.runtime.getURL(…))` never appear in the
manifest, so if `web_accessible_resources` doesn't cover them they fail at run time with a cross-origin error.
This check computes the content scripts' module closure and verifies each one — during development it really did catch
a real defect: "`src/ui/controls.js`, used by the panel, is not exposed to pages".

More design notes (an item-by-item comparison with course2md, the full trade-offs of chunked polishing, a point-by-point
check against kill-ai-slop, and the pitfalls hit along the way) are in [DESIGN.md](DESIGN.md) (in Chinese).

## Known limits

- **Upstream APIs change.** The YouTube subtitle token and the Bilibili subtitle API are both verified on real pages (`npm run check:sites`),
  but they can change at any time; `src/adapters/` is the part most likely to need maintenance.
- **In-browser WebGPU ASR is not implemented yet.** Fast processing currently relies on offline decoding in the browser or the local extraction service; WebGPU would need a verifiable model and inference runtime shipped with the extension.
- **Screenshots depend on the local helper getting the video file.** It extracts frames offline with `yt-dlp` and `ffmpeg` and never touches the page's playback position. If the media can't be downloaded, the illustrated export is blocked and the reason is shown. "Many" checks the picture at most every 10 seconds within the spoken time windows, then drops near-duplicates at a 0.85 similarity threshold.
- **DRM videos can't be transcribed**: `captureStream()` gets no audio track.
- Only the player-recording fallback has to run at real playback speed.

## License

MIT; the full text is in `LICENSE`. Third-party components (shipped in the package and downloaded at run time) and their licences are listed in `THIRD_PARTY_NOTICES.md`.
The design tokens come from kill-ai-slop (Apache-2.0) with their values unchanged; the source is credited in
the comments of `src/ui/tokens.css`. Traditional/Simplified conversion uses opencc-js, whose licence file ships in `src/vendor/`.

The GIFs and screenshots in this README were all recorded by `npm run media` with this extension on real YouTube pages; everything on the page is a real result generated on the spot. The cursor and the camera zooms in the GIFs are composited afterwards from the real pointer positions and timings.
The demo lecture is MIT OpenCourseWare's *6.0001 Introduction to Computer Science and Programming in Python* (Fall 2016, Dr. Ana Bell),
used under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
The YouTube and bilibili logos in the banner come from Wikimedia Commons (public domain) and only indicate the supported sites; they are trademarks of their respective owners.
