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
![CLI ASR](https://img.shields.io/badge/ASR-CLI-246a50?style=flat-square)
[![Last commit](https://img.shields.io/github/last-commit/Tchirek/course2md-web?style=flat-square&color=246a50)](https://github.com/Tchirek/course2md-web/commits/main)

</div>

# course2md — 浏览器插件版

把视频页面变成**带画面、时间戳、跳转和可选校对**的讲义。图文下载包含 `course.md` 与 `frames/` 截图。

<p align="center">
  <img src="docs/media/demo-launch.gif" alt="点标题末尾的 ↗，浮窗先出文字，再补上课件截图" width="880">
  <br>
  <sub>点标题末尾的 ↗ 即开始：几秒内先出文字，截图随后补齐（等截图的那段已快进）</sub>
</p>

course2md Web 提供页面浮窗、字幕快取与笔记控制，转录和截图使用 [course2md CLI](https://github.com/mizorewww/course2md)。平台字幕的纯文字笔记可直接在浏览器生成。

主线从 0.4.5 继续；0.5.0–0.7.x 的独立助手、阅读器与课程库功能保存在 [legacy/standalone-helper](https://github.com/Tchirek/course2md-web/tree/legacy/standalone-helper)。

界面与设计取舍遵循 [yetone/kill-ai-slop](https://github.com/yetone/kill-ai-slop)。

---

## 它能做什么

在 YouTube 或 B 站打开一个视频，点扩展图标，选好图片密度，点「生成笔记」。弹窗随即关闭，浮窗显示进度；转录完成后先显示文字，再补截图。拖动浮窗顶部可移动，拖右下角可调整宽高；拖到屏幕最右边会吸附成全高侧栏。

更快的入口：视频标题末尾有个 ↗，点一下立即生成。这一次优先用平台字幕（没有就自动改用已配置的语音转录），图片密度沿用上次选的挡位；由它开启的自动生成，换视频后也照此办理。

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
| **润色文本** | 关 | 轻度／标准／深度；CLI 配置或自备 API，原文随时可恢复 |

点过一次「生成笔记」后，切换视频自动生成；关闭浮窗即停止自动生成。

不显示时刻时，正文不显示跳转按钮；未润色的转录段落也会补齐句末标点。

## 文字来源

### 平台字幕（默认，最快）

YouTube 优先取人工字幕，没有再取自动生成字幕；B 站取 `player/wbi/v2` 的 CC 字幕（`player/v2` 常返回别的视频的字幕，不用）。
按行滚动的自动字幕（例如 YouTube 自动字幕的 VTT，每条都重复上一条的末行）按整行收拢；人工字幕里首尾相接的两句不会被拼到一起。
YouTube 字幕要带播放器签发的访问凭证才能取到；扩展从播放器自己的字幕请求里拿凭证，拿不到时会让播放器加载一次字幕再还原字幕开关。片头广告播放时会等广告播完。
取不到平台字幕（没有字幕、需要登录、接口不通、字幕与视频不符等）时，这一次会自动改用已配置的语音转录，浮窗里只给一行提示；「文字来源」设置保持不变。

### CLI 转录与截图

<a id="cli-connection"></a>

安装 [course2md 2.0 CLI](https://github.com/mizorewww/course2md/wiki/CLI-Guide)（已验证 v2.0.0-rc.6），用 `course2md doctor` 检查依赖。在线媒体需要 `yt-dlp`；截图和音轨处理需要 `ffmpeg` / `ffprobe`。GPU / CPU 转录需要 `llama-server`，Apple Silicon 可用 CoreML，支持的 Intel 设备可用 NPU。模型由 CLI 按需下载与准备，Web 不再维护另一套推理服务。

浏览器无法直接运行本机命令，目前 CLI 也没有浏览器连接入口，因此保留一份标准库传送脚本。先加载扩展，安装 Python 3.11+ 与 Node.js 22+，再从仓库或 `course2md-cli-bridge-<版本>.zip` 登记连接一次：

```sh
node tools/install-local-asr.mjs
```

它自动识别扩展 ID，把传送脚本放在稳定的应用数据目录，并登记 Chrome / Edge。Node 只用于登记；日常从浮窗生成时由浏览器唤醒 Python，再调用 CLI。Windows、macOS、Linux 使用相同协议，不设置登录自启。设置页的「使用 CLI」检查连接并选择 CLI 转录；`cli` 是设置里的接口标记，不是 HTTP 服务地址。

CLI 可从 PATH、应用数据目录的 `bin/` 或 `C2MD_UPSTREAM_EXE` 找到。配置沿用 `course2md/config.toml`：Windows 在 `%APPDATA%`，macOS / Linux 在 `$XDG_CONFIG_HOME` 或 `~/.config`。模型目录、计算后端和服务认证由 CLI 处理；本扩展不修改该配置，也不删除共享模型或课程数据。CLI 若配置 API 转录，音频将发送至该 API。

也可填写本机 OpenAI 转录端点，例如 `http://127.0.0.1:8080/v1/audio/transcriptions`。这种自配接口仍保留浏览器离线解码与播放器录音回退；CLI 失败会直接给出原因。

截图使用 CLI 返回的真实时刻。密度切换只筛选同一份画面目录，章节、段落与阅读位置保持稳定。B 站浏览器登录态通过临时私有快照交给 CLI，任务结束即清理；YouTube 下载使用 CLI 自身支持的认证，当前协议不能接收浏览器 cookie 快照。

`npm run local:check-host` 检查浏览器登记与冷启动，`npm run check:cli` 使用真实 CLI、短视频和本机测试接口检查转录、截图、润色与取消，不下载大模型。卸载用 `npm run local:uninstall`；`-- --purge` 只额外删除连接文件和临时任务，保留 CLI 的模型、配置与课程库。

## 润色怎么配

「CLI 配置」沿用 course2md 已配置的模型、端点和登录方式（包括 Ollama / Codex）；可用 `course2md llm setup` 完成配置。「自备 API」继续使用浏览器里的 OpenAI 兼容接口、密钥与模型名，密钥只存在 local storage，不同步；点击「授权访问此地址」授予具体接口权限。

轻度／标准／深度、自定义指令、术语表与上一块的只读上下文均保留，只作用于当前 Web 任务。浏览器接口仍逐段流式显示，CLI 逐块回写。自备 API 三次失败后可回落到 CLI 配置；CLI 请求的重试交给 CLI，避免叠加计费。关闭润色即可切回完整原文，失败的块也保留原文。

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

原生 ESM，零构建。安装开发依赖后：

```sh
npm ci
npm run lint         # 清单与严格类型检查
npm test             # 浏览器核心、流式响应、认证与生命周期
npm run check:cli    # 真实 CLI 的端到端协议检查
npm run check:layout # 无头 Chrome 的布局与滚动锚定
npm run check        # 完整检查
npm run pack         # 检查通过后产出扩展包、连接包与 SHA256SUMS
npm run shots        # 界面状态截图
npm run serve        # 本地自测台
```

CLI 检查需要媒体工具；没有显式选择 CLI 时，检查脚本下载 SHA-256 固定的官方测试二进制。CI 在 Windows、macOS、Linux 检查真实协议和浏览器宿主，发布直接使用已验证的产物。传送脚本只使用 Python 标准库，没有 pip、虚拟环境或额外模型下载器。

字幕、分段、术语与显示逻辑在浏览器；传送层只处理认证、任务寿命和结果映射。设计取舍见 [DESIGN.md](DESIGN.md)。

## 已知边界

- 平台字幕接口仍可能变化；浏览器内 WebGPU 转录尚未实现。
- CLI 模式依赖本机 CLI 及其媒体／推理依赖。浏览器连接仍需一次登记，纯扩展无法自行写入系统注册信息。
- CLI 原始进度不逐句输出；已有转录检查点用于显示部分文字，润色结果按块回写。
- 图文导出需要视频可下载；DRM 媒体不受支持。自配接口的播放器录音回退按播放速度处理。
- 阅读器、共享课程库浏览和独立安装器属于 `legacy/standalone-helper` 分支；主线保留 0.4.5 的页面笔记流程。

## 许可

MIT，全文见 `LICENSE`。第三方组件（随包分发的与运行时下载的）及其许可列在 `THIRD_PARTY_NOTICES.md`。
设计令牌取自 kill-ai-slop（Apache-2.0），数值原样保留，出处写在
`src/ui/tokens.css` 的注释里。繁简转换使用 opencc-js，许可文件随 `src/vendor/` 提供。

README 里的动图与截图都由 `npm run media` 用本扩展在真实 YouTube 页面上录制，页面内容都是现场生成的真实结果；动图里的光标与镜头推拉是后期按真实操作的位置与时刻合成的。
演示课程为 MIT OpenCourseWare《6.0001 Introduction to Computer Science and Programming in Python》（Fall 2016，Dr. Ana Bell），
按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 使用。
横幅中的 YouTube 与 bilibili 标志取自 Wikimedia Commons（公有领域），仅用于标示所支持的站点；它们是各自所有者的商标。
