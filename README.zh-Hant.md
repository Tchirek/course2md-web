<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/banner-dark.svg">
  <img alt="course2md：影片 → 圖文講義" src="docs/media/banner-light.svg" width="100%">
</picture>

[简体中文](README.md) · **正體中文** · [English](README.en.md) · [日本語](README.ja.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Tchirek/course2md-web/ci.yml?branch=legacy%2Fstandalone-helper&style=flat-square&label=CI&logo=githubactions&logoColor=white)](https://github.com/Tchirek/course2md-web/actions/workflows/ci.yml)
[![Download](https://img.shields.io/badge/download-two_editions-246a50?style=flat-square)](https://github.com/Tchirek/course2md-web/releases/latest)
[![License](https://img.shields.io/github/license/Tchirek/course2md-web?style=flat-square&color=246a50)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-246a50?style=flat-square&logo=googlechrome&logoColor=white)
![Chrome / Edge 116+](https://img.shields.io/badge/Chrome%20%2F%20Edge-116%2B-246a50?style=flat-square&logo=microsoftedge&logoColor=white)
![Zero build](https://img.shields.io/badge/build-zero--step-246a50?style=flat-square)
![tsc --checkJs](https://img.shields.io/badge/types-tsc%20----checkJs-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Local-first ASR](https://img.shields.io/badge/ASR-local--first-246a50?style=flat-square)
[![Last commit](https://img.shields.io/github/last-commit/Tchirek/course2md-web?style=flat-square&color=246a50)](https://github.com/Tchirek/course2md-web/commits/legacy/standalone-helper)

</div>

Web 提供獨立版和 CLI 版，可在[發行頁](https://github.com/Tchirek/course2md-web/releases/latest)直接選擇。本分支維護獨立版的助手與本機處理；CLI 版原始碼位於 [main](https://github.com/Tchirek/course2md-web/tree/main)。

# course2md — 瀏覽器擴充功能版

把影片頁面變成**帶畫面、時間戳、跳轉和可選校對**的講義。圖文下載包含 `course.md` 與 `frames/` 截圖。

<p align="center">
  <img src="docs/media/demo-launch.gif" alt="點標題末尾的 ↗，浮動視窗先出文字，再補上課件截圖" width="880">
  <br>
  <sub>點標題末尾的 ↗ 即開始：幾秒內先出文字，截圖隨後補齊（等截圖的那段已快進）</sub>
</p>

> **注意：** 擴充功能的介面目前為簡體中文，文中引用的按鈕與選項名稱保留介面上的原文，例如「生成笔记」。

這是 [mizorewww/course2md](https://github.com/mizorewww/course2md) 的瀏覽器版本：
它把「影片 → 圖文講義」搬進瀏覽器。平臺字幕與可直接讀取的普通影片不需要外部工具；
YouTube、B 站的快速音軌提取可選用 `yt-dlp` 和 `ffmpeg`。文字來源可以是**平臺字幕**，也可以是**你自己跑的本機模型轉錄**。

介面與設計取捨遵循 [yetone/kill-ai-slop](https://github.com/yetone/kill-ai-slop)。

---

## 它能做什麼

在 YouTube 或 B 站開啟一個影片，點擴充功能圖示，選好圖片密度，點「生成笔记」。彈出視窗隨即關閉，浮動視窗顯示進度；轉錄完成後先顯示文字，再補截圖。拖動浮動視窗頂部可移動，拖右下角可調整寬高；拖到螢幕最右邊會吸附成全高側欄。

更快的入口：影片標題末尾有個 ↗，點一下立即生成。這一次優先用平臺字幕（沒有就自動改用本地模型轉錄），圖片密度沿用上次選的檔位；由它開啟的自動生成，換影片後也照此辦理。

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
| **润色文本** | 關 | 輕度／標準／深度；標準沿用原提示詞；自備 LLM 失敗會自動回落到本機 FireRedPunc+Qwen |

點過一次「生成笔记」後，切換影片自動生成；關閉浮動視窗即停止自動生成。

不顯示時刻時，正文不顯示跳轉按鈕；未潤色的轉錄段落也會補齊句末標點。

## 文字來源

### 平臺字幕（預設，最快）

YouTube 優先取人工字幕，沒有再取自動生成字幕；B 站取 `player/wbi/v2` 的 CC 字幕（`player/v2` 常返回別的影片的字幕，不用）。
按行捲動的自動字幕（例如 YouTube 自動字幕的 VTT，每條都重複上一條的末行）按整行收攏；人工字幕裡首尾相接的兩句不會被拼在一起。
YouTube 字幕要帶播放器簽發的存取憑證才能取到；擴充功能從播放器自己的字幕請求裡拿憑證，拿不到時會讓播放器載入一次字幕再還原字幕開關。片頭廣告播放時會等廣告播完。
取不到平臺字幕（沒有字幕、需要登入、API 不通、字幕與影片不符等）時，這一次會自動改用本地模型轉錄，浮動視窗裡只給一行提示；「文字来源」設定保持不變。

### 本地模型轉錄

優先通過本機提取服務直接下載和處理串流音軌；可直接讀取的短影片（不超過 3 分鐘、24 MiB）在瀏覽器裡離線解碼。兩條快路徑都不等播放器走完。本機提取服務按停頓把音軌切成一段段語音（與原版 course2md 同一規則：太長的一段在最安靜處切開，內建轉錄每段不超過 20 秒，自備服務不超過設定裡的切片長度），再交給本機 ASR 服務；瀏覽器直讀與播放器錄音按切片長度切。
YouTube、B 站下載失敗時，本機助手會用目前瀏覽器中該影片站點的登入狀態重試。擴充功能只向 `127.0.0.1` 的本機助手傳送該站點 cookie；助手把它交給 `yt-dlp` 下載，並在任務結束後刪除暫存檔。Edge 會在擴充功能更新後提示新增的站點 cookie 權限。

在設定頁點「安裝本機助手」，下載進度、繼續下載與重試都在當前頁完成。Windows / macOS 下載後再點「開啟安裝器」，按瀏覽器和系統提示確認；安裝完成會自動連線，無須尋找腳本、解壓縮原始碼或填寫路徑。Linux 提供單檔 `.run`，首次安裝仍需執行它（`sh 安裝器檔名.run`）；擴充功能無法替瀏覽器執行腳本。安裝器沿用既有執行環境，缺少的 Node、Python、FFmpeg 與 yt-dlp 按固定版本和 SHA-256 自動準備，隨後部署、註冊並啟動助手。原始碼壓縮包與以下命令供開發者使用：

```sh
npm run local:install
```

本機轉錄用的是與原版 [course2md](https://github.com/mizorewww/course2md) 相同的模型：**Qwen3-ASR-1.7B**（GGUF，Q8_0 與 mmproj 兩個檔案，共約 2.5 GB），由 llama.cpp 的 `llama-server` 執行。模型放在原版的模型目錄裡，佈局也與原版一致：取原版 `config.toml`（Windows 在 `%APPDATA%\course2md\`，macOS / Linux 在 `~/.config/course2md/`）裡 `[defaults] model_dir` 指定的目錄，沒有指定就用原版的預設位置（Windows `%LOCALAPPDATA%\course2md\models`，macOS / Linux `~/.cache/course2md/models`）。裝過原版的機器不用再下載；先裝本擴充功能的，以後裝原版時模型已經就位。那裡已有的檔案與固定的 SHA-256 一致才用，不一致就原樣保留並報錯，不會覆蓋原版的檔案。原版執行時用 `--model-dir` 臨時指定的目錄，請用環境變數 `C2MD_MODEL_DIR` 告訴助手。

本機轉錄需要 Node.js 22、Python 3.11 或更新版本（只用標準函式庫，不建虛擬環境）和 `ffmpeg`；YouTube、B 站快速提取還需要 `yt-dlp`。不再安裝 faster-whisper、PyTorch 或單獨的 CUDA 函式庫：llama.cpp 執行庫（固定版本 `b11235`）與本機潤色共用一份，PATH 上已有同一版本就直接用，否則下載並校驗。Windows（NVIDIA 顯示卡）與 macOS 用顯示卡加速，Linux 用 CPU；顯示卡起不來或轉錄中途出錯就改用 CPU 繼續，浮動視窗裡給一行提示。

安裝命令把輕量本機助手註冊為原生訊息主機（擴充功能因此能自動喚醒它），並設定登入後執行。Windows 用登錄檔加編譯的 exe 主機；macOS / Linux 寫瀏覽器的 `NativeMessagingHosts` 目錄，登入自啟分別走 LaunchAgent 和 XDG autostart。安裝腳本會在 Edge / Chrome 的配置裡找出已載入的本擴充功能（以未封裝方式載入的擴充功能 ID 隨所在資料夾而變），只允許這些擴充功能呼叫助手，所以請先在瀏覽器載入擴充功能再執行；也可以直接帶上 ID：`node tools/install-local-asr.mjs <擴充功能ID>`。以前版本裝過的 faster-whisper 轉錄環境與模型（約 2.5 GB）會在這一步刪掉；只拉取了新程式碼、沒重跑安裝的，本機助手啟動時也會刪。
選擇本地模型轉錄後，助手會在任務開始時自動啟動服務；設定頁按鈕也可手動啟動，按鈕會顯示下載、載入與就緒狀態，並自動填好轉錄地址和模型名。本機轉錄與潤色模型 10 分鐘沒有任務就會退出並釋放記憶體（環境變數 `C2MD_IDLE_SECONDS` 可調），下次用到時自動重新載入。安裝只需一次：以後更新程式碼，本機助手啟動時會自動修復過時的主機註冊，無須重跑；移動了專案目錄才需要重新安裝。

資料目錄（主機、存取權杖、潤色環境與執行庫）預設在 `%LOCALAPPDATA%\course2md`（macOS / Linux 在各自的應用程式資料目錄）；系統磁碟空間緊張時，執行 `npm run local:install -- --data-dir D:\course2md` 把它移到別的磁碟，之後一直沿用。資料目錄不在預設位置、原版既沒有指定模型目錄、預設位置也還沒有模型時，安裝（或更新程式碼後第一次本機轉錄）會把 `<資料目錄>\models` 寫進原版的 `config.toml`（其餘內容原樣保留），兩邊以後都用那裡的模型。解除安裝執行 `npm run local:uninstall`（加 `-- --purge` 連潤色環境與執行庫一起刪）；與原版共用的轉錄模型不會刪除。

本機助手只監聽 `127.0.0.1`，除健康檢查外的請求都要帶存取權杖；權杖只經原生訊息交給本擴充功能，
機器上的其他擴充功能和網頁都用不了它讀本機檔案。執行時下載的模型與執行環境都固定了版本與 SHA-256
（`tools/runtime-pins.json`），驗證通過才使用。
安裝最後會經剛註冊的主機拉起助手，主機不通就當場報錯。擴充功能喚不醒助手時會寫明斷在哪一環（未註冊、擴充功能 ID 不符、Node 或助手路徑失效等）。
可執行 `npm run local:check-host` 核對瀏覽器能否找到主機並驗證主機能否從零拉起服務（預設核對瀏覽器裡已載入的所有副本，也可在命令後加 `-- <擴充功能ID>` 指定），`npm run local:check` 核對本機服務是否真的接收音訊。

也可以接入自己已有的 OpenAI 相容 ASR 服務，任選其一：

```sh
# whisper.cpp（預設 8080 埠，路徑剛好是 /v1/audio/transcriptions）
./server -m models/ggml-base.bin

# faster-whisper-server（預設 8000 埠）
faster-whisper-server --model large-v3
```

然後到擴充功能設定頁的「本地模型转录」填服務地址、模型名，點「测试连接」和「授权访问此地址」。

沒有安裝登入後執行的本機助手時，也可手動執行提取服務：

```sh
npm run fast-asr
```

它只監聽 `127.0.0.1:8766`，用 `yt-dlp` 取網路音軌或直接讀取本地檔案，再由 `ffmpeg` 切片，最後呼叫上面配置的本機 ASR。B 站預設 CDN 失敗時會嘗試備用線路。瀏覽器能直接讀取的短媒體不需要它。
YouTube 的 JavaScript 挑戰由現有 Node.js 執行環境處理，需 Node.js 22 或更高版本。

**受限媒體的回退：**

- YouTube、B 站的本機提取和瀏覽器直讀都失敗時會顯示原因並停止，不再自動錄音。其他無法快速提取的媒體才用播放器錄音；此時一小時的課至少一小時，期間**標籤頁要保持開著**。
- 錄製期間影片會真的播放，聲音會被壓到很低但不會是靜音（元素靜音時錄到的就是靜音）。
- 切片邊界有約 40ms 的間隙，極端情況下可能丟半個字。這是為了讓每個切片能獨立解碼。
- 經本機提取服務轉錄時，時間戳落在每段話開始的地方；瀏覽器直讀與錄音回退按固定切片送出，服務只返回整段文字時，時間戳精度是切片級別。

## 潤色怎麼配

設定頁可在「本机／自定义」間切換潤色模型。舊設定仍自動沿用已填寫的遠端模型；未填遠端時，勾選「润色文本」會啟動本機 [FireRedPunc](https://huggingface.co/FireRedTeam/FireRedPunc) 與 [Qwen3.5-2B 的 Q4 量化版](https://huggingface.co/SoAIHQ/Qwen3.5-2B-GGUF)；首次使用會下載模型。8 GB 視訊記憶體機器一次只處理一塊，避免與轉錄模型搶視訊記憶體。

也可填寫任意 OpenAI 相容的 `/chat/completions` 端點。

在設定頁填：服務地址（到 `/v1` 為止）、API key（本機服務留空）、模型名。
然後點「授权访问此地址」——OpenAI 相容的端點基本都不發 CORS 頭，沒有這一步請求會被
瀏覽器攔掉。金鑰只存在瀏覽器的 local storage，**不參與同步**。

可選填兩樣東西，都很值：

- **术语表**：每行一條。同音字錯得最多的永遠是專有名詞，寫下來一行就解決。
- **自定义校对指令**：留空用內建指令。輸出格式的約束由擴充功能強制追加，改不動它。

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

有登記的桌面保存位置就直接沿用；尚未安裝桌面端時使用同一設定目錄的 `desktop-local-library`，日後可由桌面端讀取。無須填寫絕對路徑；失效的位置需在桌面端重新選擇。正文、原文、截圖和字幕時間線以 course2md 2.0 schema 1 保存，重複同步不會回退較新的版本。同步需要所選版本的本機連接，不建立桌面任務紀錄。

## 安裝

[發行頁](https://github.com/Tchirek/course2md-web/releases/latest)同時列出兩版最近已驗證的擴充功能包、對應元件及安裝說明。版本號各自遞增，依用途選擇一個擴充功能包：

| 版本 | 適合 | 轉錄與截圖需要 |
| --- | --- | --- |
| **獨立版 · Standalone** | 由 Web 管理本機模型、轉錄、截圖與潤色 | Web 本機助手，提供 Windows / macOS / Linux 安裝器；無須另裝 CLI |
| **CLI 版 · CLI** | 透過精簡連接層沿用 course2md CLI 的模型、設定與處理能力 | course2md 2.0 CLI + 一次瀏覽器連接登記 |

兩版都有浮窗、字幕快取、圖片密度與自備 API；平臺字幕的純文字筆記可直接使用擴充功能。本說明對應獨立版。

還沒上架商店。用「載入未封裝項目」：

1. 開啟 `chrome://extensions`（Edge 是 `edge://extensions`），開啟右上角的**開發人員模式**；
2. 點**載入未封裝項目**，選擇所選擴充功能 ZIP 的解壓縮資料夾（開發時也可選對應分支的儲存庫資料夾）；
3. 到 YouTube 或 B 站點開一個影片，點工具列裡的圖示。

需要 Chrome/Edge 116 或更高。

**支援的站點**：YouTube（`/watch`）、嗶哩嗶哩（`/video/`）、以及任何頁面上有 `<video>`
的頁面（後者需要在彈出視窗裡點一次授權）。在瀏覽器裡直接開啟本地影片檔案也能用——那正是
course2md 的「本地錄製」場景。

## 開發

零建置：沒有打包器，沒有建置產物。內容腳本用動態 `import()` 載入 ESM。

```sh
npm run check        # 清單自檢 + 型別檢查 + 單元測試 + 佈局斷言，一次跑完（CI 同款）
npm test             # 只跑單元測試（純邏輯，node --test）
npm run check:manifest # 清單自檢：引用的檔案都在、模組閉包可被頁面取到、權限對得上
npm run typecheck    # tsc --checkJs 按 strict 檢查整個 src/（程式碼仍是 JS，零建置）
npm run check:layout # 只跑幾何斷言：面板佈局、按鈕底色、無橫向溢位
npm run check:sites  # 在真實 YouTube / B 站頁面上跑真擴充功能（需要網路，不進 CI）
npm run check:image  # 用三次場景變化的實際影片檢查四個圖片密度檔位
npm run shots        # 各狀態截圖 → tools/shots/
npm run pack         # 先跑完整檢查，通過才打包到 dist/（推送本分支後 CI 自動發布，兩版下載入口同步更新）
npm run media        # 在真實 YouTube 頁面上用本擴充功能錄製 README 的示範素材 → docs/media/
npm run icons        # 重新生成擴充功能圖示（自己柵格化 + 自己編碼 PNG，無原生依賴）
npm run serve        # 自測伺服器：http://127.0.0.1:8787/tools/selftest.html
```

`tools/` 裡的東西只用於開發，不參與執行。自測臺之所以需要
`tools/chrome-mock.js`：Chrome 137 起 `--load-extension` 已被移除，想在
Chrome 裡截圖只能給 `chrome.*` 打一層替身——產品程式碼裡沒有任何為截圖開的後門。

`npm run check:manifest` 值得單獨說一句：manifest 裡寫錯一個路徑，Chrome 只會讓那個
部件**靜默失效**；而內容腳本用 `import(chrome.runtime.getURL(…))` 動態載入的模組不在
manifest 裡出現，`web_accessible_resources` 覆蓋不到就會在執行時報跨源錯誤。
這個檢查會算出內容腳本的模組閉包並逐個核對——它在開發過程中確實抓到過一次
「面板引用的 `src/ui/controls.js` 沒被頁面授權」的真實缺陷。

進一步的設計說明（含與 course2md 的逐項對照、潤色分塊的完整權衡、kill-ai-slop 的
逐條對照、以及踩過的坑）見 [DESIGN.md](DESIGN.md)。

## 已知邊界

- **上游 API 會變。** YouTube 字幕憑證、B 站字幕 API都在真實頁面上驗證過（`npm run check:sites`），
  但隨時可能調整，`src/adapters/` 是最可能需要維護的部分。
- **瀏覽器內 WebGPU ASR 尚未實現。** 目前的快速處理依靠瀏覽器離線解碼或本機提取服務；WebGPU 需要隨擴充功能打包可驗證的模型與推理執行環境。
- **截圖依賴本機助手取得影片檔案。** 它用 `yt-dlp` 和 `ffmpeg` 離線取幀，不改動頁面播放進度。無法下載媒體時會阻止圖文匯出並顯示原因。各檔先按講述時間窗取候選畫面（「多」最多每 10 秒一張），再用原版 0.85 的相似度門檻，略去與兩分鐘內已保留畫面相同的。
- **DRM 影片無法轉錄**，`captureStream()` 拿不到音軌。
- 只有播放器錄音回退需要按真實播放速度走。

## 授權

MIT，全文見 `LICENSE`。第三方元件（隨包分發的與執行時下載的）及其授權列在 `THIRD_PARTY_NOTICES.md`。
設計 token取自 kill-ai-slop（Apache-2.0），數值原樣保留，出處寫在
`src/ui/tokens.css` 的註解裡。繁簡轉換使用 opencc-js，授權檔案隨 `src/vendor/` 提供。

README 裡的 GIF 與截圖都由 `npm run media` 用本擴充功能在真實 YouTube 頁面上錄製，頁面內容都是現場生成的真實結果；GIF 裡的游標與鏡頭推拉是後期按真實操作的位置與時刻合成的。
示範課程為 MIT OpenCourseWare《6.0001 Introduction to Computer Science and Programming in Python》（Fall 2016，Dr. Ana Bell），
按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 使用。
橫幅中的 YouTube 與 bilibili 標誌取自 Wikimedia Commons（公有領域），僅用於標示所支援的站點；它們是各自所有者的商標。
