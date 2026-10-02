<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/banner-dark.svg">
  <img alt="course2md：講義動画 → 図入りノート" src="docs/media/banner-light.svg" width="100%">
</picture>

[简体中文](README.md) · [正體中文](README.zh-Hant.md) · [English](README.en.md) · **日本語**

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

# course2md — ブラウザ拡張版

動画のページを、**画面・タイムスタンプ・ジャンプ・任意の校正つき**の講義ノートに変えます。図入りダウンロードには `course.md` と `frames/` のスクリーンショットが入ります。

<p align="center">
  <img src="docs/media/demo-launch.gif" alt="動画タイトル末尾の ↗ を押すと、パネルにまず文字が出て、続いてスライドの画像がそろう" width="880">
  <br>
  <sub>タイトル末尾の ↗ を押すだけ：数秒で文字が出て、画像があとから埋まります（画像待ちの部分は早送り）</sub>
</p>

> **注：** 拡張の画面表示は現在、簡体字中国語のみです。この README では画面上の表記を中国語のまま引用し、訳を添えています（例：「生成笔记」（ノートを生成））。

course2md Web は浮動パネル、字幕の高速取得、ブラウザ内のノート操作を担当し、文字起こしと画像抽出には [course2md CLI](https://github.com/mizorewww/course2md) を使います。字幕から文字だけのノートを作る場合はブラウザだけで動きます。

Web には Standalone 版と CLI 版があり、[リリースページ](https://github.com/Tchirek/course2md-web/releases/latest)で選べます。このブランチは CLI 版を開発し、Standalone 版のソースは [legacy/standalone-helper](https://github.com/Tchirek/course2md-web/tree/legacy/standalone-helper) にあります。

画面と設計上の取捨は [yetone/kill-ai-slop](https://github.com/yetone/kill-ai-slop) に従っています。

---

## できること

YouTube か Bilibili で動画を開き、拡張のアイコンを押して画像の密度を選び、「生成笔记」（ノートを生成）を押します。ポップアップはすぐ閉じ、浮遊パネルに進み具合が出ます。文字起こしが終わるとまず文字、続いて画像が表示されます。パネルは見出しをドラッグして移動、右下の角で大きさを変えられ、画面の右端まで運ぶと全高のサイドバーに吸着します。

もっと手早い入口：動画タイトルの末尾に ↗ があり、押せばすぐ生成が始まります。その回はプラットフォームの字幕を優先し（無ければ設定済みの文字起こしに切り替え）、画像の密度は前回選んだ段階を使います。この方法で始めた自動生成は、動画を切り替えても同じようにします。

- 浮遊パネルは、画面ごとのまとまりで動画のスクリーンショットと話した内容を並べます。
- タイムスタンプを押すと、動画のその位置へ飛びます。
- 「复制 Markdown」（Markdown をコピー）は文字版をコピーします。図入りダウンロードは `course.md` と `frames/slide_*.jpg` を同じフォルダに保存します。
- 生成中でもコピーとダウンロードを押せます。ボタンが破線枠の「完成后复制」「完成后下载」（完了後にコピー／ダウンロード）に変わり、画像と校正を含めてすべて終わった瞬間に自動で実行されます。もう一度押すと取り消し。
- 拡張のコードがディスク上で更新されたのに再読み込みしていない場合、ページから始めた生成は、まず拡張を再読み込みしてページを更新し、それから生成を続けます。

<table>
  <tr>
    <th width="50%">生成中にコピー・ダウンロード：終わった瞬間に実行</th>
    <th width="50%">画像の密度はいつでも切り替え：なし／少／標準／多</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/demo-deferred.gif" alt="生成中にコピーとダウンロードを押すとボタンが破線枠の「完了後にコピー」「完了後にダウンロード」になり、終わると「コピー済み」「保存済み」と出る"></td>
    <td align="center"><img src="docs/media/demo-density.gif" alt="パネルで画像の密度を順に切り替える"></td>
  </tr>
</table>

### 出来上がるノート

図入りダウンロードは一つのフォルダになります：

```text
<動画のタイトル>/
├── course.md
└── frames/
    ├── slide_0001.jpg
    ├── slide_0002.jpg
    └── …
```

`course.md` の冒頭（実際の出力の抜粋。長い段落は途中で省略）。見出し情報の項目名は中国語で書かれます：

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

## 表示と処理

パネルは画面の右端までドラッグすると全高のサイドバーになり、配色はシステムのライト／ダークに従います：

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/panel-dark.png">
  <img alt="全高のサイドバーに吸着したパネル。左で講義が流れ、右にスクリーンショットとタイムスタンプつきのノート" src="docs/media/panel-light.png">
</picture>

| 設定 | 既定 | 動作 |
| --- | --- | --- |
| **显示讲述时刻**（タイムスタンプを表示） | オン | 段落ごとに `mm:ss` を付け、押すとその位置へ |
| **显示图片**（画像を表示） | 標準 | なし／少／標準／多。変化した画面だけを残し、「多」は最多で 10 秒ごとに一枚 |
| **校正** | オフ | 軽度／標準／深度、CLI 設定または独自 API、原文を保持 |

一度「生成笔记」を押したあとは、動画を切り替えると自動で生成します。パネルを閉じると自動生成は止まります。

タイムスタンプを隠すと本文にジャンプ用のボタンは出ません。校正していない文字起こしの段落にも、文末の句読点は補われます。

## 文字の出どころ

### プラットフォームの字幕（既定・最速）

YouTube は人が付けた字幕を優先し、無ければ自動生成字幕を使います。Bilibili は `player/wbi/v2` の CC 字幕を使います（`player/v2` はよく別の動画の字幕を返すので使いません）。
行送りで流れる自動字幕（YouTube 自動字幕の VTT のように、各 cue が前の cue の最後の行を繰り返すもの）は行単位でまとめます。人の作った字幕で前後が接しているだけの二つの文をつなげることはありません。
YouTube の字幕はプレーヤーが発行するアクセス用の証票を付けないと取れません。拡張はプレーヤー自身の字幕リクエストから証票を受け取り、無いときはプレーヤーに一度字幕を読み込ませてから字幕のオン・オフを元に戻します。冒頭の広告が流れている間は、広告の終わりを待ちます。
プラットフォームの字幕が取れないとき（字幕が無い、ログインが要る、API が通らない、字幕が動画と合わない など）は、その回だけ設定済みの文字起こしに切り替え、パネルには一行だけ知らせます。「文字来源」（文字の出どころ）の設定は変わりません。

### CLI による文字起こしと画像抽出

<a id="cli-connection"></a>

[course2md 2.0 CLI](https://github.com/mizorewww/course2md/wiki/CLI-Guide) を導入し、`course2md doctor` で依存ツールを確認します。検証済みの版は v2.0.0-rc.6 です。オンライン動画には `yt-dlp`、動画処理には `ffmpeg` / `ffprobe` が必要です。GPU / CPU 認識には `llama-server` が必要で、Apple Silicon では CoreML、対応する Intel デバイスでは NPU を選べます。モデルは CLI が必要に応じて準備します。

ブラウザはローカルコマンドを直接実行できず、現在の CLI にもブラウザ用の接続機能がありません。標準ライブラリだけの短い接続スクリプトを使います。拡張を読み込み、Python 3.11+ と Node.js 22+ を用意して、リポジトリまたは `course2md-cli-bridge-<版>.zip` から一度登録します。

```sh
node tools/install-local-asr.mjs
```

登録は拡張 ID を自動検出し、安定したアプリデータ領域に接続ファイルを置きます。Node は登録時だけ必要です。通常は Chrome / Edge が Python を起動し、CLI を呼び出します。Windows、macOS、Linux 共通で、ログイン時の自動起動は設定しません。「使用 CLI」で接続を確認し、CLI の文字起こしを選べます。`cli` は設定上の印で、HTTP アドレスではありません。

CLI は PATH、アプリデータ領域の `bin/`、または `C2MD_UPSTREAM_EXE` から探します。`course2md/config.toml` は Windows の `%APPDATA%`、その他の OS の `$XDG_CONFIG_HOME` または `~/.config` にあります。モデルの場所、処理バックエンド、認証は CLI が担当します。Web は設定や共有モデル、講義データを変更・削除しません。API 認識を設定している場合、音声はその API に送られます。

独自のループバック OpenAI 認識 API では、ブラウザのオフライン復号と録音へのフォールバックも使えます。CLI の失敗時は原因をそのまま表示します。画像は CLI が返す実際の時刻を保ち、密度変更はキャッシュの表示だけを変えるため段落は動きません。Bilibili のブラウザ認証は一時的な私有ファイルで渡します。YouTube のダウンロードは CLI 側の対応認証を使い、ブラウザ cookie の受け渡しには未対応です。

`npm run local:check-host` で登録とコールドスタート、`npm run check:cli` で実 CLI・短い動画・ローカルテスト API を検証します。大きなモデルは取得しません。解除は `npm run local:uninstall`。`-- --purge` でも削除するのは接続ファイルと一時タスクだけで、共有モデル・設定・ライブラリは残します。

## 校正の設定

「CLI 配置」は course2md のモデル、エンドポイント、認証（Ollama / Codex を含む）を使います。`course2md llm setup` で設定できます。「自备 API」はブラウザに保存した OpenAI 互換設定を使い、キーは local storage のみに保存され、同期されません。「授权访问此地址」で API のアクセスを許可します。

軽度／標準／深度、独自指示、用語集、前ブロックの読み取り専用文脈は今回の Web タスクに適用します。ブラウザ API は段落単位でストリーム表示し、CLI はブロック単位で結果を返します。独自 API が三回失敗すると CLI 設定へ切り替えられます。CLI の再試行は CLI に任せ、課金要求の重複を避けます。失敗したブロックも原文を保持します。

### なぜ「ブロックに分けて送る」のか

一文ずつでも全文まとめてでもなく、**段落の区切り**でブロックに分け（既定は 20 段落／1,200 字）、並行して送ります：

- 一文ずつ：モデルに前後の文脈が見えず、文の区切りを直せません。1 時間の講義だと千回単位のリクエストになります。
- 全文まとめて：文脈の長さを超え、途中で失敗すれば全部やり直し、長い出力は内容がずれやすくなります。
- ブロックごと：ブロックの中は連続した完全な段落で、ブロック同士は並行して動き、互いに影響しません。各ブロックには**前のブロックの最後の文**も
  読み取り専用の文脈として付けるので、ブロックの境目でも文章がつながります。

どのブロックにも**id ごとに一件ずつ返す**よう求め、id が合わなければそのブロックは原文のまま残します。最悪でも「ここは校正されなかった」で済み、
「文章がずれた」ことにはなりません。

「润色文本」を外すとすぐに原文が表示されます。原文は常に残してあるので、原文を見るのにモデルへ問い合わせ直す必要はありません。

## course2md にノートを送る

同期ボタンは既定で非表示です。設定で「显示 course2md 同步按钮」を有効にし、生成後に浮動パネルの同期アイコンを押します。ノートをデスクトップの既定の保存先に書き込むだけで、閲覧と講義管理はデスクトップ側で行います。どちらの Web 版にも独立リーダーやライブラリ画面はありません。

登録済みの保存先を使い、デスクトップ未導入なら同じ設定ディレクトリの `desktop-local-library` に保存します。絶対パスの入力は不要です。登録先が消えた場合はデスクトップ側で選び直してください。本文、原文、画像、字幕の時間線は course2md 2.0 schema 1 で保存し、再送しても新しい版を古い版に戻しません。選んだ版のローカル接続が必要で、デスクトップのタスク履歴は作成しません。

## インストール

[リリースページ](https://github.com/Tchirek/course2md-web/releases/latest)に両方の最新版の検証済み拡張 ZIP、対応する部品と手順を載せています。版番号は別々に進むので、用途に合わせて拡張を一つ選んでください。

| 版 | 向いている用途 | 文字起こし・画像抽出に必要なもの |
| --- | --- | --- |
| **Standalone** | Web がモデル、文字起こし、画像、校正を管理 | Web ヘルパー（Windows / macOS / Linux インストーラあり）。CLI の別途導入は不要 |
| **CLI** | 小さな接続層で course2md CLI のモデル・設定・処理を共用 | course2md 2.0 CLI と一度のブラウザ接続登録 |

両方とも浮動ノート、字幕の高速取得、画像密度、独自 API に対応します。字幕から文字だけのノートを作るなら拡張だけで動きます。この README は CLI 版の説明です。

ストアにはまだ出していません。「パッケージ化されていない拡張機能を読み込む」を使います：

1. `chrome://extensions`（Edge は `edge://extensions`）を開き、右上の**デベロッパー モード**をオンにする。
2. **パッケージ化されていない拡張機能を読み込む**を押し、選んだ拡張 ZIP を展開したフォルダ（開発時は対応ブランチのリポジトリ）を選ぶ。
3. YouTube か Bilibili で動画を開き、ツールバーのアイコンを押す。

Chrome/Edge 116 以上が必要です。

**対応サイト**：YouTube（`/watch`）、Bilibili（`/video/`）、そしてページ上に `<video>` がある
あらゆるページ（後者はポップアップで一度許可を押す必要があります）。ブラウザで直接開いたローカルの動画ファイルにも使えます。これはまさに
course2md の「ローカル録画」の場面です。

## 開発

ネイティブ ESM、ビルド不要です。

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

CLI 検証には動画ツールが必要です。CLI を明示しない場合は SHA-256 を固定した公式テストバイナリを取得します。CI は Windows、macOS、Linux で実プロトコルとブラウザホストを検証し、検証済みの成果物を公開します。接続層は Python 標準ライブラリだけで動き、pip や仮想環境、独自モデル取得処理はありません。[DESIGN.md](DESIGN.md) に設計判断をまとめています。

## 既知の限界

- 字幕 API は変更されることがあります。ブラウザ内 WebGPU 認識は未実装です。
- CLI と動画・推論の依存ツールが必要です。ブラウザ接続は一度登録します。
- CLI は逐句ストリームを返しません。保存されたチェックポイントから途中の文字を表示し、校正はブロック単位で返します。
- 図入り出力には取得可能な動画が必要です。DRM は非対応で、独自 API の録音フォールバックは再生速度に従います。
- 両版とも 0.4.5 のページ内ノート機能を継続し、閲覧と講義管理は course2md デスクトップが担当します。

## ライセンス

MIT。全文は `LICENSE` にあります。サードパーティの部品（同梱のもの、実行時にダウンロードするもの）とそのライセンスは `THIRD_PARTY_NOTICES.md` にまとめてあります。
デザイントークンは kill-ai-slop（Apache-2.0）から取り、値はそのまま残してあります。出典は
`src/ui/tokens.css` のコメントにあります。繁体字・簡体字の変換には opencc-js を使っており、そのライセンスファイルは `src/vendor/` に同梱しています。

この README の GIF とスクリーンショットは、どれも `npm run media` がこの拡張を本物の YouTube のページで動かして録ったもので、ページの中身はその場で生成された本物の結果です。GIF の光標と寄り引きは、実際の操作の位置と時刻をもとに後から合成しています。
実演の講義は MIT OpenCourseWare の《6.0001 Introduction to Computer Science and Programming in Python》（Fall 2016、Dr. Ana Bell）で、
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) に基づいて使っています。
横幕の YouTube と bilibili のロゴは Wikimedia Commons（パブリックドメイン）から取り、対応サイトを示すためだけに使っています。いずれも各所有者の商標です。
