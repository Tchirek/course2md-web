<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/banner-dark.svg">
  <img alt="course2md：影片 → 圖文講義" src="docs/media/banner-light.svg" width="100%">
</picture>

[简体中文](README.md) · **正體中文** · [English](README.en.md) · [日本語](README.ja.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Tchirek/course2md-web/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white)](https://github.com/Tchirek/course2md-web/actions/workflows/ci.yml)
[![Download](https://img.shields.io/badge/download-two_editions-246a50?style=flat-square)](https://github.com/Tchirek/course2md-web/releases/latest)
[![License](https://img.shields.io/github/license/Tchirek/course2md-web?style=flat-square&color=246a50)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-246a50?style=flat-square&logo=googlechrome&logoColor=white)
![Chrome / Edge 116+](https://img.shields.io/badge/Chrome%20%2F%20Edge-116%2B-246a50?style=flat-square&logo=microsoftedge&logoColor=white)
![Zero build](https://img.shields.io/badge/build-zero--step-246a50?style=flat-square)
![tsc --checkJs](https://img.shields.io/badge/types-tsc%20----checkJs-3178c6?style=flat-square&logo=typescript&logoColor=white)
![CLI ASR](https://img.shields.io/badge/ASR-CLI-246a50?style=flat-square)
[![Last commit](https://img.shields.io/github/last-commit/Tchirek/course2md-web?style=flat-square&color=246a50)](https://github.com/Tchirek/course2md-web/commits/main)

</div>

# course2md — 瀏覽器擴充功能版

把影片頁面變成**帶畫面、時間戳、跳轉和可選校對**的講義。圖文下載包含 `course.md` 與 `frames/` 截圖。

<p align="center">
  <img src="docs/media/demo-launch.gif" alt="點標題末尾的 ↗，浮動視窗先出文字，再補上課件截圖" width="880">
  <br>
  <sub>點標題末尾的 ↗ 即開始：幾秒內先出文字，截圖隨後補齊（等截圖的那段已快進）</sub>
</p>

> **注意：** 擴充功能的介面目前為簡體中文，文中引用的按鈕與選項名稱保留介面上的原文，例如「生成笔记」。

course2md Web 提供頁面浮窗、字幕快取與筆記控制，轉錄和截圖使用 [course2md CLI](https://github.com/mizorewww/course2md)。平臺字幕的純文字筆記可直接在瀏覽器生成。

Web 提供獨立版和 CLI 版，可在[發行頁](https://github.com/Tchirek/course2md-web/releases/latest)直接選擇。本分支維護 CLI 版；獨立版原始碼位於 [legacy/standalone-helper](https://github.com/Tchirek/course2md-web/tree/legacy/standalone-helper)。

介面與設計取捨遵循 [yetone/kill-ai-slop](https://github.com/yetone/kill-ai-slop)。

---

## 它能做什麼

在 YouTube 或 B 站開啟一個影片，點擴充功能圖示，選好圖片密度，點「生成笔记」。彈出視窗隨即關閉，浮動視窗顯示進度；轉錄完成後先顯示文字，再補截圖。拖動浮動視窗頂部可移動，拖右下角可調整寬高；拖到螢幕最右邊會吸附成全高側欄。

更快的入口：影片標題末尾有個 ↗，點一下立即生成。這一次優先用平臺字幕（沒有就自動改用已設定的語音轉錄），圖片密度沿用上次選的檔位；由它開啟的自動生成，換影片後也照此辦理。

- 頁面浮動視窗按畫面段落展示影片截圖和講述文字；
- 點時間戳跳到影片對應位置；
- 「复制 Markdown」保持文字版；圖文下載在同一資料夾中儲存 `course.md` 和 `frames/slide_*.jpg`；
- 還在生成時也能點複製或下載：按鈕變成虛線框的「完成后复制」「完成后下载」，全部完成（含截圖與潤色）的一刻自動執行；再點一次取消。
- 擴充功能程式碼更新後沒重新載入時，從頁面發起的生成會先自動重新載入擴充功能、重新整理頁面，再接著生成。

<table>
  <tr>
    <th width="50%">還在生成就點複製、下載：完成的一刻自動執行</th>
    <th width="50%">圖片密度隨時切換：無／少／預設／多</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/demo-deferred.gif" alt="生成中點複製與下載，按鈕變為虛線框的「完成后复制」「完成后下载」，完成時顯示「已复制」「已保存」"></td>
    <td align="center"><img src="docs/media/demo-density.gif" alt="在浮動視窗裡依次切換圖片密度"></td>
  </tr>
</table>

### 生成的講義

圖文下載得到一個資料夾：

```text
<影片標題>/
├── course.md
└── frames/
    ├── slide_0001.jpg
    ├── slide_0002.jpg
    └── …
```

`course.md` 的開頭（真實輸出節選，長段落從中截斷）：

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

## 顯示與處理

浮動視窗可以拖到螢幕最右邊吸附成全高側欄，配色跟隨系統深淺色：

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/panel-dark.png">
  <img alt="吸附成全高側欄的浮動視窗，左邊是正在播放的課程，右邊是帶截圖與時間戳的講義" src="docs/media/panel-light.png">
</picture>

| 選項 | 預設 | 行為 |
| --- | --- | --- |
| **显示讲述时刻** | 開 | 每段文字前標出 `mm:ss`，點選即可跳轉 |
| **显示图片** | 預設 | 無／少／預設／多；只保留有變化的畫面，「多」最多每 10 秒一張 |
| **潤色文本** | 關 | 輕度／標準／深度；CLI 設定或自備 API，原文可隨時恢復 |

點過一次「生成笔记」後，切換影片自動生成；關閉浮動視窗即停止自動生成。

不顯示時刻時，正文不顯示跳轉按鈕；未潤色的轉錄段落也會補齊句末標點。

## 文字來源

### 平臺字幕（預設，最快）

YouTube 優先取人工字幕，沒有再取自動生成字幕；B 站取 `player/wbi/v2` 的 CC 字幕（`player/v2` 常返回別的影片的字幕，不用）。
按行捲動的自動字幕（例如 YouTube 自動字幕的 VTT，每條都重複上一條的末行）按整行收攏；人工字幕裡首尾相接的兩句不會被拼在一起。
YouTube 字幕要帶播放器簽發的存取憑證才能取到；擴充功能從播放器自己的字幕請求裡拿憑證，拿不到時會讓播放器載入一次字幕再還原字幕開關。片頭廣告播放時會等廣告播完。
取不到平臺字幕（沒有字幕、需要登入、API 不通、字幕與影片不符等）時，這一次會自動改用已設定的語音轉錄，浮動視窗裡只給一行提示；「文字来源」設定保持不變。

### CLI 轉錄與截圖

<a id="cli-connection"></a>

安裝 [course2md 2.0 CLI](https://github.com/mizorewww/course2md/wiki/CLI-Guide)（已驗證 v2.0.0-rc.6），執行 `course2md doctor` 檢查依賴。線上媒體需要 `yt-dlp`，媒體處理需要 `ffmpeg` / `ffprobe`。GPU / CPU 轉錄需要 `llama-server`；Apple Silicon 可用 CoreML，支援的 Intel 裝置可用 NPU。模型由 CLI 按需準備，Web 不另建推理服務。

瀏覽器不能直接執行本機命令，目前 CLI 也沒有瀏覽器傳送介面，透過 MizoreLink 連接，使用 Python 標準函式庫。先載入擴充功能，安裝 Python 3.11+ 和 Node.js 22+，再從倉庫或 `course2md-cli-bridge-<版本>.zip` 登記一次：

```sh
node tools/install-local-asr.mjs
```

登記會自動偵測擴充功能 ID，安裝至穩定的應用資料目錄。Node 僅在登記時使用；日常由 Chrome / Edge 喚醒 Python 並呼叫 CLI。Windows、macOS、Linux 使用相同協定，不設定登入自啟。設定頁的「使用 CLI」檢查連接並選用 CLI；`cli` 是設定標記，不是 HTTP 位址。

CLI 從 PATH、應用資料目錄的 `bin/` 或 `C2MD_UPSTREAM_EXE` 取得。沿用 `course2md/config.toml`：Windows 位於 `%APPDATA%`，其他系統位於 `$XDG_CONFIG_HOME` 或 `~/.config`。模型位置、運算後端與服務認證由 CLI 處理，Web 不修改設定或刪除共用模型與課程。API 轉錄設定會將音訊送往該 API。

自訂本機 OpenAI 轉錄端點仍支援瀏覽器離線解碼及播放器錄音回退；CLI 失敗會直接顯示原因。截圖使用 CLI 回傳的真實時刻，密度切換只篩選同一份快取，段落及閱讀位置不變。B 站登入態透過私有暫存快照傳給 CLI；YouTube 下載使用 CLI 自身支援的認證，目前協定不能接收瀏覽器 cookie 快照。

`npm run local:check-host` 檢查登記與冷啟動；`npm run check:cli` 用真實 CLI、短影片及本機測試服務驗證，不下載大模型。卸載用 `npm run local:uninstall`；`-- --purge` 只額外移除連接檔案與暫存任務，保留 CLI 模型、設定與課程庫。

## 潤色怎麼配

「CLI 配置」沿用 course2md 的模型、端點和登入方式（包括 Ollama / Codex），可用 `course2md llm setup` 設定。「自备 API」沿用瀏覽器內的 OpenAI 相容介面；密鑰只保存在 local storage，不同步，點「授权访问此地址」授予介面權限。

輕度／標準／深度、自訂指令、術語表與上一塊唯讀上下文均保留，僅作用於本次 Web 任務。瀏覽器介面逐段串流，CLI 逐塊回寫。自備 API 三次失敗後可回落至 CLI；CLI 自行處理重試，避免疊加計費。原文和失敗區塊始終可用。

### 為什麼是「分塊傳送」

不是逐句發，也不是整篇發，而是按**段落邊界**切塊（預設 20 段 / 1200 字）並行傳送：

- 逐句發：模型看不到上下文，修不了斷句，一小時的課上千次請求。
- 整篇發：超出上下文，中途失敗全部白做，長輸出容易漂移。
- 分塊發：塊內是連續的完整段落，塊與塊並行、互不影響。每塊還帶上**上一塊的尾句**
  作為唯讀上下文，所以跨塊邊界處仍然連貫。

每塊都要求模型**逐條按 id 返回**，id 對不上就整塊保留原文。最壞結果是「這段沒潤色」，
不會出現「文字錯位」。

關掉「润色文本」會立刻顯示原文——原文一直留著，看原文不需要重新請求模型。

## 同步到 course2md

預設不顯示同步入口。需要時，在設定頁勾選「显示 course2md 同步按钮」，生成完成後點浮窗的同步圖示。它只把筆記寫入桌面端的預設保存位置，不開啟閱讀頁，也不管理課程。兩版都不內建閱讀器或課程庫介面。

有登記的桌面保存位置就直接沿用；尚未安裝桌面端時使用同一設定目錄的 `desktop-local-library`，日後可由桌面端讀取。無須填寫絕對路徑；失效的位置需在桌面端重新選擇。正文、原文、截圖和字幕時間線以 course2md 2.0 schema 1 保存，重複同步不會回退較新的版本。同步需要所選版本的 MizoreLink，不建立桌面任務紀錄。

## 安裝

[發行頁](https://github.com/Tchirek/course2md-web/releases/latest)同時列出兩版最近已驗證的擴充功能包、對應元件及安裝說明。版本號各自遞增，依用途選擇一個擴充功能包：

| 版本 | 適合 | 轉錄與截圖需要 |
| --- | --- | --- |
| **獨立版 · Standalone** | 由 Web 管理本機模型、轉錄、截圖與潤色 | MizoreLink，提供 Windows / macOS / Linux 安裝器；無須另裝 CLI |
| **CLI 版 · CLI** | 透過精簡連接層沿用 course2md CLI 的模型、設定與處理能力 | course2md 2.0 CLI + MizoreLink（登記一次） |

兩版都有浮窗、字幕快取、圖片密度與自備 API；平臺字幕的純文字筆記可直接使用擴充功能。本說明對應 CLI 版。

還沒上架商店。用「載入未封裝項目」：

1. 開啟 `chrome://extensions`（Edge 是 `edge://extensions`），開啟右上角的**開發人員模式**；
2. 點**載入未封裝項目**，選擇所選擴充功能 ZIP 的解壓縮資料夾（開發時也可選對應分支的儲存庫資料夾）；
3. 到 YouTube 或 B 站點開一個影片，點工具列裡的圖示。

需要 Chrome/Edge 116 或更高。

**支援的站點**：YouTube（`/watch`）、嗶哩嗶哩（`/video/`）、以及任何頁面上有 `<video>`
的頁面（後者需要在彈出視窗裡點一次授權）。在瀏覽器裡直接開啟本地影片檔案也能用——那正是
course2md 的「本地錄製」場景。

## 開發

原生 ESM，零建置。

```sh
npm ci
npm run lint
npm test
npm run check:cli
npm run check:layout
npm run check
npm run pack
npm run shots
npm run serve
```

CLI 檢查需要媒體工具，未明確指定 CLI 時下載 SHA-256 固定的官方測試二進位。CI 在 Windows、macOS、Linux 檢查真實協定與瀏覽器宿主，直接發布驗證過的產物。傳送層僅用 Python 標準函式庫，不使用 pip、虛擬環境或另一套模型下載器。設計取捨見 [DESIGN.md](DESIGN.md)。

## 已知邊界

- 平臺字幕介面可能變動；瀏覽器內 WebGPU 轉錄尚未實作。
- CLI 及媒體／推理依賴需在本機安裝，瀏覽器連接仍需一次登記。
- CLI 不逐句串流；轉錄檢查點提供部分文字，潤色結果逐塊回寫。
- 圖文匯出需要可下載的媒體，DRM 不受支援；自訂介面的錄音回退依播放速度處理。
- 兩版都保留 0.4.5 的頁面筆記流程，不內建閱讀器或課程管理；獨立版安裝器位於 `legacy/standalone-helper`。

## 授權

MIT，全文見 `LICENSE`。第三方元件（隨包分發的與執行時下載的）及其授權列在 `THIRD_PARTY_NOTICES.md`。
設計 token取自 kill-ai-slop（Apache-2.0），數值原樣保留，出處寫在
`src/ui/tokens.css` 的註解裡。繁簡轉換使用 opencc-js，授權檔案隨 `src/vendor/` 提供。

README 裡的 GIF 與截圖都由 `npm run media` 用本擴充功能在真實 YouTube 頁面上錄製，頁面內容都是現場生成的真實結果；GIF 裡的游標與鏡頭推拉是後期按真實操作的位置與時刻合成的。
示範課程為 MIT OpenCourseWare《6.0001 Introduction to Computer Science and Programming in Python》（Fall 2016，Dr. Ana Bell），
按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 使用。
橫幅中的 YouTube 與 bilibili 標誌取自 Wikimedia Commons（公有領域），僅用於標示所支援的站點；它們是各自所有者的商標。
