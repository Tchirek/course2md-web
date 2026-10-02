# 第三方组件与许可

本项目自身以 MIT 许可发布（见 `LICENSE`）。下列第三方内容或随发布包一起分发，或在
用户机器上运行时下载。

## 随发布包分发

| 组件 | 位置 | 许可 | 说明 |
| --- | --- | --- | --- |
| [opencc-js](https://github.com/nk2028/opencc-js) | `src/vendor/opencc-t2cn.js` | MIT | 繁简转换；许可全文见 `src/vendor/OpenCC-LICENSE` |
| [opencc-data](https://github.com/nk2028/opencc-data)（OpenCC 词典） | 内嵌于 `src/vendor/opencc-t2cn.js` | Apache-2.0 | 许可全文见 `src/vendor/OpenCC-Apache-LICENSE` 与 `src/vendor/OpenCC-THIRD_PARTY_LICENSES.md` |
| [kill-ai-slop](https://github.com/yetone/kill-ai-slop) 设计令牌 | `src/ui/tokens.css` | Apache-2.0 | 取自 `website/src/styles/tokens.css`，数值原样保留，仅把作用域改为 `.c2md-scope`（文件头注明出处与改动）；Apache-2.0 全文同 `src/vendor/OpenCC-Apache-LICENSE` |

## 运行时下载（不随发布包分发）

启用本机转录或本机润色时，本机助手按 `tools/runtime-pins.json` 里固定的版本下载下列组件
（模型与运行库另外固定了 SHA-256，校验通过才使用）。转录模型与原版 course2md 共用同一份文件，
原版已下载过就不再下载。本机润色的 Python 包装进本项目自己的虚拟环境，不改动用户的全局 Python：

| 组件 | 固定版本 | 许可 |
| --- | --- | --- |
| [ggml-org/Qwen3-ASR-1.7B-GGUF](https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF)（Q8_0 与 mmproj，本机转录，与原版 course2md 共用） | 提交 `36a6786` | Apache-2.0 |
| 本机润色环境的依赖（transformers、tokenizers、safetensors 等，完整清单见 `polish-python`） | 见清单 | Apache-2.0 等 |
| [FireRedASR2S](https://github.com/FireRedTeam/FireRedASR2S) 中的 `fireredpunc` 源码 | 提交 `4e7d9aa` | Apache-2.0 |
| [FireRedTeam/FireRedPunc](https://huggingface.co/FireRedTeam/FireRedPunc) 模型 | 提交 `e448fd9` | Apache-2.0 |
| [SoAIHQ/Qwen3.5-2B-GGUF](https://huggingface.co/SoAIHQ/Qwen3.5-2B-GGUF)（Q4_K_M） | 提交 `dcd0300` | Apache-2.0 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) 运行库（转录与润色共用） | 发布 `b11235` | MIT |

各系统安装器在缺少运行环境时按固定版本与 SHA-256 下载下列组件（Unix 清单见 `tools/bootstrap-pins.json`）；已有程序可以继续使用，下载的二进制不随发布包分发，下载包保留在 `bootstrap/`：

| 组件 | 固定版本 | 许可 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/dist/v24.13.0/) | 24.13.0 | MIT，附带组件见下载包许可 |
| [Python](https://www.python.org/downloads/release/python-31312/) | 3.13.12 | PSF，附带组件见安装包许可 |
| [Python standalone（macOS / Linux）](https://github.com/astral-sh/python-build-standalone/releases/tag/20260901) | CPython 3.13.15 / 20260901 | PSF；附带组件及许可见下载包与项目发布说明 |
| [FFmpeg Windows 构建](https://www.gyan.dev/ffmpeg/builds/) | 8.1.2 essentials | GPL-3.0；完整构建、许可和对应源码入口保留在 `bootstrap/` 下载包与构建站点 |
| [FFmpeg Linux 构建](https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-10-01-19-27) | N-127083-g65a3870462 | GPL-3.0；构建说明与源码见发布项目 |
| [FFmpeg macOS 构建](https://www.osxexperts.net/) | Intel 8.0 / Apple Silicon 9.0 | GPL-3.0；构建说明与对应源码入口见构建站点 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19) | 2026.08.19 | 主程序 Unlicense；Windows 打包及附带组件见发布说明 |
| [course2md CLI](https://github.com/mizorewww/course2md/releases/tag/v2.0.0-rc.6) | 2.0.0-rc.6 | MIT，按 `tools/engine-pins.json` 校验 |
