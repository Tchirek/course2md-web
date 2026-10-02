# course2md 桌面同步

兼容基线：course2md `v2.0.0-rc.6`，源码 `83b935347c7a`。本页描述当前实现。

## 分工

两版都保留 0.4.5 的页面笔记体验，不包含独立阅读器、库列表、版本选择、课程管理或浏览器内的库读取接口。

| 功能 | Standalone | CLI |
| --- | --- | --- |
| 平台字幕、浮窗、图片密度、原文切换、复制与下载 | 浏览器 | 浏览器 |
| 转录、截图、本机润色与模型准备 | Web 助手 | course2md CLI |
| 长期阅读与课程管理 | course2md 桌面端 | course2md 桌面端 |
| 可选笔记同步 | 默认关闭，只写入 | 默认关闭，只写入 |

设置页启用「显示 course2md 同步按钮」后，生成完成的笔记可以写入桌面保存位置。同步不打开阅读页，不创建桌面任务记录，也不修改桌面工作区、AI 凭据或任务队列。它是单向保存，不是双向同步。

## 保存位置与文件

`tools/desktop_sync.py` 使用桌面配置目录中 `desktop-workspace.json` 的 `default_library`。没有桌面登记时使用该目录的 `desktop-local-library`，与桌面首次启动的默认位置一致。已登记位置消失时明确报错，由桌面端重新选择，避免静默把笔记写到另一处。

配置目录遵循 `%APPDATA%/course2md`（Windows）及 `$XDG_CONFIG_HOME/course2md` 或 `~/.config/course2md`（macOS / Linux）。测试可用 `C2MD_UPSTREAM_CONFIG` 指定配置目录或 `config.toml`。

```text
<保存位置>/<课程身份>/
├── current.json
└── versions/<版本身份>/
    ├── manifest.json
    ├── document.json
    ├── course.md
    ├── frames/
    ├── timeline.jsonl
    ├── web-document.json
    └── web-provenance.json
```

`document.json` 使用 course2md schema 1。章节、原文和被润色跳过的段落额外保存在网页文档；取得的原始字幕或转录时间线保存在 `timeline.jsonl`。B 站各分 P 使用独立来源身份。桌面端读取有效版本；同步不伪造已入队的桌面任务。

## 发布与验证

两版只暴露带访问令牌的 `POST /desktop/publish`。没有库查询、连接、图片读取、历史版本读取或引擎导出路由。CLI 当前没有直接导入浏览器文稿的命令，因此两版共用同一份标准库写入适配，而非再次下载视频或启动 ASR。

写入校验结构、时间线、图片、路径和资产 SHA-256，使用与 course2md 一致的进程间发布锁、暂存目录和原子版本指针。失败保留旧笔记；同内容重试返回同一结果，不覆盖或回滚桌面较新的版本。

`npm test` 覆盖转换、完整原文导出、默认关闭、受保护的写入请求、校验、锁与中断恢复。CLI 版的 `npm run check:cli` 以及独立版的 `npm run check:upstream` 用真实 course2md 引擎在隔离目录补做摘要与三种导出，验证它能读取网页版本、遵守相同发布锁，且网页重试不回退引擎的新版本。测试只调用 localhost 模拟 LLM，不需要模型或真实密钥。

桌面保存与读取契约见 course2md 的 [artifact.rs](https://github.com/mizorewww/course2md/blob/83b935347c7a/src/artifact.rs)、[workspace.rs](https://github.com/mizorewww/course2md/blob/83b935347c7a/desktop/src/workspace.rs) 和 [pipeline.rs](https://github.com/mizorewww/course2md/blob/83b935347c7a/src/pipeline.rs)。
