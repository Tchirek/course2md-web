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
（模型、运行库与显卡加速库另外固定了 SHA-256，校验通过才使用）。Python 包装进本项目自己的虚拟环境，
不改动用户的全局 Python：

| 组件 | 固定版本 | 许可 |
| --- | --- | --- |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（pip） | 1.2.1 | MIT |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2)（pip） | 4.8.1 | MIT |
| 转录环境的其余依赖（PyAV、ONNX Runtime、tokenizers、huggingface_hub 等，完整清单见 `asr-python`） | 见清单 | 各自的开源许可（BSD / MIT / Apache-2.0） |
| NVIDIA [cuBLAS](https://pypi.org/project/nvidia-cublas-cu12/)（`nvidia-cublas-cu12`，仅限有 NVIDIA 显卡的机器） | 12.8.4.1 | NVIDIA Software License Agreement（CUDA 可再分发组件） |
| NVIDIA [cuDNN](https://pypi.org/project/nvidia-cudnn-cu12/)（`nvidia-cudnn-cu12`，同上） | 9.10.2.21 | NVIDIA cuDNN Software License Agreement |
| 本机润色环境的依赖（transformers、tokenizers、safetensors 等，完整清单见 `polish-python`） | 见清单 | Apache-2.0 等 |
| [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) 模型 | 提交 `536b066` | MIT |
| [FireRedASR2S](https://github.com/FireRedTeam/FireRedASR2S) 中的 `fireredpunc` 源码 | 提交 `4e7d9aa` | Apache-2.0 |
| [FireRedTeam/FireRedPunc](https://huggingface.co/FireRedTeam/FireRedPunc) 模型 | 提交 `e448fd9` | Apache-2.0 |
| [SoAIHQ/Qwen3.5-2B-GGUF](https://huggingface.co/SoAIHQ/Qwen3.5-2B-GGUF)（Q4_K_M） | 提交 `dcd0300` | Apache-2.0 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) 运行库 | 发布 `b11235` | MIT |

本机提取服务还会调用用户自行安装的 `yt-dlp`、`ffmpeg`，本项目不分发它们。
