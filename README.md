<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/banner-dark.svg">
  <img alt="course2md：视频 → 图文讲义" src="docs/media/banner-light.svg" width="100%">
</picture>

**简体中文** · [正體中文](README.zh-Hant.md) · [English](README.en.md) · [日本語](README.ja.md)

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

# course2md — 浏览器插件版

把视频页面变成**带画面、时间戳、跳转和可选校对**的讲义。图文下载包含 `course.md` 与 `frames/` 截图。

<p align="center">
  <img src="docs/media/demo-launch.gif" alt="点标题末尾的 ↗，浮窗先出文字，再补上课件截图" width="880">
  <br>
  <sub>点标题末尾的 ↗ 即开始：几秒内先出文字，截图随后补齐（等截图的那段已快进）</sub>
</p>

这是 [mizorewww/course2md](https://github.com/mizorewww/course2md) 的浏览器版本：
它把「视频 → 图文讲义」搬进浏览器。平台字幕与可直接读取的普通视频不需要外部工具；
YouTube、B 站的快速音轨提取可选用 `yt-dlp` 和 `ffmpeg`。文字来源可以是**平台字幕**，也可以是**你自己跑的本机模型转录**。

界面与设计取舍遵循 [yetone/kill-ai-slop](https://github.com/yetone/kill-ai-slop)。

---

## 它能做什么

在 YouTube 或 B 站打开一个视频，点扩展图标，选好图片密度，点「生成笔记」。弹窗随即关闭，浮窗显示进度；转录完成后先显示文字，再补截图。拖动浮窗顶部可移动，拖右下角可调整宽高；拖到屏幕最右边会吸附成全高侧栏。

更快的入口：视频标题末尾有个 ↗，点一下立即生成。这一次优先用平台字幕（没有就自动改用本地模型转录），图片密度沿用上次选的挡位；由它开启的自动生成，换视频后也照此办理。

- 页面浮窗按画面段落展示视频截图和讲述文字；
- 点时间戳跳到视频对应位置；
- 复制 Markdown 保持文字版；图文下载在同一文件夹中保存 `course.md` 和 `frames/slide_*.jpg`；
- 还在生成时也能点复制或下载：按钮变成虚线框的「完成后复制」「完成后下载」，全部完成（含截图与润色）的一刻自动执行；再点一次取消。
- 扩展代码更新后没重新加载时，从页面发起的生成会先自动重新加载扩展、刷新页面，再接着生成。

<table>
  <tr>
    <th width="50%">还在生成就点复制、下载：完成的一刻自动执行</th>
    <th width="50%">图片密度随时切换：无／少／默认／多</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/demo-deferred.gif" alt="生成中点复制与下载，按钮变为虚线框的「完成后复制」「完成后下载」，完成时显示「已复制」「已保存」"></td>
    <td align="center"><img src="docs/media/demo-density.gif" alt="在浮窗里依次切换图片密度"></td>
  </tr>
</table>

### 生成的讲义

图文下载得到一个文件夹：

```text
<视频标题>/
├── course.md
└── frames/
    ├── slide_0001.jpg
    ├── slide_0002.jpg
    └── …
```

`course.md` 的开头（真实输出节选，长段落从中截断）：

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

## 显示与处理

浮窗可以拖到屏幕最右边吸附成全高侧栏，配色跟随系统深浅色：

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/panel-dark.png">
  <img alt="吸附成全高侧栏的浮窗，左边是正在播放的课程，右边是带截图与时间戳的讲义" src="docs/media/panel-light.png">
</picture>

| 选项 | 默认 | 行为 |
| --- | --- | --- |
| **显示讲述时刻** | 开 | 每段文字前标出 `mm:ss`，点击即可跳转 |
| **显示图片** | 默认 | 无／少／默认／多；只保留有变化的画面，多档最多每 10 秒一张 |
| **润色文本** | 关 | 轻度／标准／深度；标准沿用原提示词；自备 LLM 失败会自动回落到本机 FireRedPunc+Qwen |

点过一次「生成笔记」后，切换视频自动生成；关闭浮窗即停止自动生成。

不显示时刻时，正文不显示跳转按钮；未润色的转录段落也会补齐句末标点。

## 文字来源

### 平台字幕（默认，最快）

YouTube 优先取人工字幕，没有再取自动生成字幕；B 站取 `player/wbi/v2` 的 CC 字幕（`player/v2` 常返回别的视频的字幕，不用）。
按行滚动的自动字幕（例如 YouTube 自动字幕的 VTT，每条都重复上一条的末行）按整行收拢；人工字幕里首尾相接的两句不会被拼到一起。
YouTube 字幕要带播放器签发的访问凭证才能取到；扩展从播放器自己的字幕请求里拿凭证，拿不到时会让播放器加载一次字幕再还原字幕开关。片头广告播放时会等广告播完。
取不到平台字幕（没有字幕、需要登录、接口不通、字幕与视频不符等）时，这一次会自动改用本地模型转录，浮窗里只给一行提示；「文字来源」设置保持不变。

### 本地模型转录

优先通过本机提取服务直接下载和处理流媒体音轨；可直接读取的短视频（不超过 3 分钟、24 MiB）在浏览器里离线解码。两条快路径都不等播放器走完。本机提取服务按停顿把音轨切成一段段语音（与原版 course2md 同一规则：太长的一段在最安静处切开，内置转录每段不超过 20 秒，自配服务不超过设置里的切片长度），再交给本机 ASR 服务；浏览器直读与播放器录音按切片长度切。
YouTube、B 站下载失败时，本机助手会用当前浏览器中该视频站点的登录态重试。扩展只向 `127.0.0.1` 的本机助手传送该站点 cookie；助手把它交给 `yt-dlp` 下载，并在任务结束后删除临时文件。Edge 会在扩展更新后提示新增的站点 cookie 权限。

首次在项目目录运行（Windows / macOS / Linux 通用）：

```sh
npm run local:install
```

本机转录用的是与原版 [course2md](https://github.com/mizorewww/course2md) 相同的模型：**Qwen3-ASR-1.7B**（GGUF，Q8_0 与 mmproj 两个文件，共约 2.5 GB），由 llama.cpp 的 `llama-server` 运行。模型放在原版的模型目录里，布局也与原版一致：取原版 `config.toml`（Windows 在 `%APPDATA%\course2md\`，macOS / Linux 在 `~/.config/course2md/`）里 `[defaults] model_dir` 指定的目录，没有指定就用原版的默认位置（Windows `%LOCALAPPDATA%\course2md\models`，macOS / Linux `~/.cache/course2md/models`）。装过原版的机器不用再下载；先装本扩展的，以后装原版时模型已经就位。那里已有的文件与固定的 SHA-256 一致才用，不一致就原样保留并报错，不会覆盖原版的文件。原版运行时用 `--model-dir` 临时指定的目录，请用环境变量 `C2MD_MODEL_DIR` 告诉助手。

本机转录需要 Node.js 22、Python 3.11 或更新版本（只用标准库，不建虚拟环境）和 `ffmpeg`；YouTube、B 站快速提取还需要 `yt-dlp`。不再安装 faster-whisper、PyTorch 或单独的 CUDA 库：llama.cpp 运行库（固定版本 `b11235`）与本机润色共用一份，PATH 上已有同一版本就直接用，否则下载并校验。Windows（NVIDIA 显卡）与 macOS 用显卡加速，Linux 用 CPU；显卡起不来或转录中途出错就改用 CPU 继续，浮窗里给一行提示。

安装命令把轻量本机助手注册为原生消息宿主（插件因此能自动唤醒它），并设置登录后运行。Windows 用注册表加编译的 exe 宿主；macOS / Linux 写浏览器的 `NativeMessagingHosts` 目录，登录自启分别走 LaunchAgent 和 XDG autostart。安装脚本会在 Edge / Chrome 的配置里找出已加载的本扩展（解压加载的扩展 ID 随所在文件夹而变），只允许这些扩展调用助手，所以请先在浏览器加载扩展再运行；也可以直接带上 ID：`node tools/install-local-asr.mjs <扩展ID>`。以前版本装过的 faster-whisper 转录环境与模型（约 2.5 GB）会在这一步删掉；只拉取了新代码、没重跑安装的，本机助手启动时也会删。
选择本地模型转录后，助手会在任务开始时自动启动服务；设置页按钮也可手动启动，按钮会显示下载、加载与就绪状态，并自动填好转录地址和模型名。本机转录与润色模型 10 分钟没有任务就会退出并释放内存（环境变量 `C2MD_IDLE_SECONDS` 可调），下次用到时自动重新加载。安装只需一次：以后更新代码，本机助手启动时会自动修复过时的宿主注册，无须重跑；移动了项目目录才需要重新安装。

数据目录（宿主、访问令牌、润色环境与运行库）默认在 `%LOCALAPPDATA%\course2md`（macOS / Linux 在各自的应用数据目录）；系统盘空间紧张时，运行 `npm run local:install -- --data-dir D:\course2md` 把它移到别的盘，之后一直沿用。数据目录不在默认位置、原版既没有指定模型目录、默认位置也还没有模型时，安装（或更新代码后第一次本机转录）会把 `<数据目录>\models` 写进原版的 `config.toml`（其余内容原样保留），两边以后都用那里的模型。卸载运行 `npm run local:uninstall`（加 `-- --purge` 连润色环境与运行库一起删）；与原版共用的转录模型不会删除。

本机助手只监听 `127.0.0.1`，除健康检查外的请求都要带访问令牌；令牌只经原生消息交给本扩展，
机器上的其他扩展和网页都用不了它读本机文件。运行时下载的模型与运行库都固定了版本与 SHA-256
（`tools/runtime-pins.json`），校验通过才使用。
安装最后会经刚注册的宿主拉起助手，宿主不通就当场报错。插件唤不醒助手时会写明断在哪一环（未注册、扩展 ID 不符、Node 或助手路径失效等）。
可运行 `npm run local:check-host` 核对浏览器能否找到宿主并验证宿主能否从零拉起服务（默认核对浏览器里已加载的所有副本，也可在命令后加 `-- <扩展ID>` 指定），`npm run local:check` 核对本机服务是否真的接收音频。

也可以接入自己已有的 OpenAI 兼容 ASR 服务，任选其一：

```sh
# whisper.cpp（默认 8080 端口，路径刚好是 /v1/audio/transcriptions）
./server -m models/ggml-base.bin

# faster-whisper-server（默认 8000 端口）
faster-whisper-server --model large-v3
```

然后到插件设置页的「本地模型转录」填服务地址、模型名，点「测试连接」和「授权访问此地址」。

没有安装登录后运行的本机助手时，也可手动运行提取服务：

```sh
npm run fast-asr
```

它只监听 `127.0.0.1:8766`，用 `yt-dlp` 取网络音轨或直接读取本地文件，再由 `ffmpeg` 切片，最后调用上面配置的本机 ASR。B 站默认 CDN 失败时会尝试备用线路。浏览器能直接读取的短媒体不需要它。
YouTube 的 JavaScript 挑战由现有 Node.js 运行时处理，需 Node.js 22 或更高版本。

**受限媒体的回退：**

- YouTube、B 站的本机提取和浏览器直读都失败时会显示原因并停止，不再自动录音。其他无法快速提取的媒体才用播放器录音；此时一小时的课至少一小时，期间**标签页要保持开着**。
- 录制期间视频会真的播放，声音会被压到很低但不会是静音（元素静音时录到的就是静音）。
- 切片边界有约 40ms 的间隙，极端情况下可能丢半个字。这是为了让每个切片能独立解码。
- 经本机提取服务转录时，时间戳落在每段话开始的地方；浏览器直读与录音回退按固定切片送出，服务只返回整段文本时，时间戳精度是切片级别。

## 润色怎么配

设置页可在「本机／自定义」间切换润色模型。旧设置仍自动沿用已填写的远端模型；未填远端时，勾选「润色文本」会启动本机 [FireRedPunc](https://huggingface.co/FireRedTeam/FireRedPunc) 与 [Qwen3.5-2B 的 Q4 量化版](https://huggingface.co/SoAIHQ/Qwen3.5-2B-GGUF)；首次使用会下载模型。8 GB 显存机器使用单块并发，避免与转录模型抢显存。

也可填写任意 OpenAI 兼容的 `/chat/completions` 端点。

在设置页填：服务地址（到 `/v1` 为止）、API key（本机服务留空）、模型名。
然后点「授权访问此地址」——OpenAI 兼容的端点基本都不发 CORS 头，没有这一步请求会被
浏览器拦掉。密钥只存在浏览器的 local storage，**不参与同步**。

可选填两样东西，都很值：

- **术语表**：每行一条。同音字错得最多的永远是专有名词，写下来一行就解决。
- **自定义校对指令**：留空用内置指令。输出格式的约束由插件强制追加，改不动它。

### 为什么是「分块发送」

不是逐句发，也不是整篇发，而是按**段落边界**切块（默认 20 段 / 1200 字）并发发送：

- 逐句发：模型看不到上下文，修不了断句，一小时的课上千次请求。
- 整篇发：超出上下文，中途失败全部白做，长输出容易漂移。
- 分块发：块内是连续的完整段落，块与块并行、互不影响。每块还带上**上一块的尾句**
  作为只读上下文，所以跨块边界处仍然连贯。

每块都要求模型**逐条按 id 返回**，id 对不上就整块保留原文。最坏结果是「这段没润色」，
不会出现「文字错位」。

关掉「润色文本」会立刻显示原文——原文一直留着，看原文不需要重新请求模型。

## 安装

还没上架商店。用「加载已解压的扩展」：

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），打开右上角的**开发者模式**；
2. 点**加载已解压的扩展程序**，选择这个仓库目录；
3. 到 YouTube 或 B 站点开一个视频，点工具栏里的图标。

需要 Chrome/Edge 116 或更高。

**支持的站点**：YouTube（`/watch`）、哔哩哔哩（`/video/`）、以及任何页面上有 `<video>`
的页面（后者需要在弹窗里点一次授权）。在浏览器里直接打开本地视频文件也能用——那正是
course2md 的「本地录制」场景。

## 开发

零构建：没有打包器，没有构建产物。内容脚本用动态 `import()` 加载 ESM。

```sh
npm run check        # 清单自检 + 类型检查 + 单测 + 布局断言，一次跑完（CI 同款）
npm test             # 只跑单测（纯逻辑，node --test）
npm run check:manifest # 清单自检：引用的文件都在、模块闭包可被页面取到、权限对得上
npm run typecheck    # tsc --checkJs 检查 src/（代码仍是 JS，零构建）
npm run check:layout # 只跑几何断言：面板布局、按钮底色、无横向溢出
npm run check:sites  # 在真实 YouTube / B 站页面上跑真扩展（需要网络，不进 CI）
npm run check:image  # 用三次场景变化的实际视频检查四档图片密度
npm run shots        # 各状态截图 → tools/shots/
npm run pack         # 先跑完整检查，通过才打出两个发布包到 dist/（推送到 main 后 CI 会自动发布 release，版本号自动递增）
npm run media        # 在真实 YouTube 页面上用本扩展录制 README 的演示素材 → docs/media/
npm run icons        # 重新生成扩展图标（自己栅格化 + 自己编码 PNG，无原生依赖）
npm run serve        # 自测服务器：http://127.0.0.1:8787/tools/selftest.html
```

`tools/` 里的东西只用于开发，不参与运行。自测台之所以需要
`tools/chrome-mock.js`：Chrome 137 起 `--load-extension` 已被移除，想在
Chrome 里截图只能给 `chrome.*` 打一层替身——产品代码里没有任何为截图开的后门。

`npm run check:manifest` 值得单独说一句：manifest 里写错一个路径，Chrome 只会让那个
部件**静默失效**；而内容脚本用 `import(chrome.runtime.getURL(…))` 动态加载的模块不在
manifest 里出现，`web_accessible_resources` 覆盖不到就会在运行时报跨源错误。
这个检查会算出内容脚本的模块闭包并逐个核对——它在开发过程中确实抓到过一次
「面板引用的 `src/ui/controls.js` 没被页面授权」的真实缺陷。

进一步的设计说明（含与 course2md 的逐项对照、润色分块的完整权衡、kill-ai-slop 的
逐条对照、以及踩过的坑）见 [DESIGN.md](DESIGN.md)。

## 已知边界

- **上游接口会变。** YouTube 字幕凭证、B 站字幕接口都在真实页面上验证过（`npm run check:sites`），
  但随时可能调整，`src/adapters/` 是最可能需要维护的部分。
- **浏览器内 WebGPU ASR 尚未实现。** 当前的快速处理依靠浏览器离线解码或本机提取服务；WebGPU 需要随扩展打包可验证的模型与推理运行时。
- **截图依赖本机助手取得视频文件。** 它用 `yt-dlp` 和 `ffmpeg` 离线取帧，不改动页面播放进度。无法下载媒体时会阻止图文导出并显示原因。各档先按讲述时间窗取候选画面（多档最多每 10 秒一张），再用原版 0.85 的相似度阈值，略去与两分钟内已保留画面相同的。
- **DRM 视频无法转录**，`captureStream()` 拿不到音轨。
- 只有播放器录音回退需要按真实播放速度走。

## 许可

MIT，全文见 `LICENSE`。第三方组件（随包分发的与运行时下载的）及其许可列在 `THIRD_PARTY_NOTICES.md`。
设计令牌取自 kill-ai-slop（Apache-2.0），数值原样保留，出处写在
`src/ui/tokens.css` 的注释里。繁简转换使用 opencc-js，许可文件随 `src/vendor/` 提供。

README 里的动图与截图都由 `npm run media` 用本扩展在真实 YouTube 页面上录制，页面内容都是现场生成的真实结果；动图里的光标与镜头推拉是后期按真实操作的位置与时刻合成的。
演示课程为 MIT OpenCourseWare《6.0001 Introduction to Computer Science and Programming in Python》（Fall 2016，Dr. Ana Bell），
按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 使用。
横幅中的 YouTube 与 bilibili 标志取自 Wikimedia Commons（公有领域），仅用于标示所支持的站点；它们是各自所有者的商标。
