# 第三方组件与许可

本项目自身以 MIT 许可发布（见 `LICENSE`）。下列内容涉及随包分发的组件和开发检查所用的外部引擎。

## 随发布包分发

| 组件 | 位置 | 许可 | 说明 |
| --- | --- | --- | --- |
| [opencc-js](https://github.com/nk2028/opencc-js) | `src/vendor/opencc-t2cn.js` | MIT | 繁简转换；许可全文见 `src/vendor/OpenCC-LICENSE` |
| [opencc-data](https://github.com/nk2028/opencc-data)（OpenCC 词典） | 内嵌于 `src/vendor/opencc-t2cn.js` | Apache-2.0 | 许可全文见 `src/vendor/OpenCC-Apache-LICENSE` 与 `src/vendor/OpenCC-THIRD_PARTY_LICENSES.md` |
| [kill-ai-slop](https://github.com/yetone/kill-ai-slop) 设计令牌 | `src/ui/tokens.css` | Apache-2.0 | 取自 `website/src/styles/tokens.css`，数值原样保留，仅把作用域改为 `.c2md-scope`（文件头注明出处与改动）；Apache-2.0 全文同 `src/vendor/OpenCC-Apache-LICENSE` |

## 外部处理引擎与测试二进制

转录、截图与模型准备由用户安装的 [course2md CLI](https://github.com/mizorewww/course2md) 处理，本项目不分发 CLI、模型或推理运行库。相关依赖及许可以 course2md 的发行说明为准。

`tools/check-cli.py` 仅在开发／CI 检查中下载官方 CLI 测试二进制，版本与 SHA-256 记录在 `tools/engine-pins.json`。传送脚本只使用 Python 标准库；媒体工具 `yt-dlp`、`ffmpeg` 和 `ffprobe` 由用户或 CI 环境提供。
