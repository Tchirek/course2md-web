<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/banner-dark.svg">
  <img alt="course2md：講義動画 → 図入りノート" src="docs/media/banner-light.svg" width="100%">
</picture>

[简体中文](README.md) · [正體中文](README.zh-Hant.md) · [English](README.en.md) · **日本語**

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

# course2md — ブラウザ拡張版

動画のページを、**画面・タイムスタンプ・ジャンプ・任意の校正つき**の講義ノートに変えます。図入りダウンロードには `course.md` と `frames/` のスクリーンショットが入ります。

<p align="center">
  <img src="docs/media/demo-launch.gif" alt="動画タイトル末尾の ↗ を押すと、パネルにまず文字が出て、続いてスライドの画像がそろう" width="880">
  <br>
  <sub>タイトル末尾の ↗ を押すだけ：数秒で文字が出て、画像があとから埋まります（画像待ちの部分は早送り）</sub>
</p>

> **注：** 拡張の画面表示は現在、簡体字中国語のみです。この README では画面上の表記を中国語のまま引用し、訳を添えています（例：「生成笔记」（ノートを生成））。

これは [mizorewww/course2md](https://github.com/mizorewww/course2md) のブラウザ版で、
「動画 → 図入りノート」をブラウザの中で完結させます。プラットフォームの字幕と、ブラウザが直接読める普通の動画には外部ツールは要りません。
YouTube・Bilibili の音声を素早く取り出すときは、任意で `yt-dlp` と `ffmpeg` を使えます。文字の出どころは**プラットフォームの字幕**でも、**自分で動かすローカルモデルの文字起こし**でも構いません。

画面と設計上の取捨は [yetone/kill-ai-slop](https://github.com/yetone/kill-ai-slop) に従っています。

---

## できること

YouTube か Bilibili で動画を開き、拡張のアイコンを押して画像の密度を選び、「生成笔记」（ノートを生成）を押します。ポップアップはすぐ閉じ、浮遊パネルに進み具合が出ます。文字起こしが終わるとまず文字、続いて画像が表示されます。パネルは見出しをドラッグして移動、右下の角で大きさを変えられ、画面の右端まで運ぶと全高のサイドバーに吸着します。

もっと手早い入口：動画タイトルの末尾に ↗ があり、押せばすぐ生成が始まります。その回はプラットフォームの字幕を優先し（無ければ自動でローカルの文字起こしに切り替え）、画像の密度は前回選んだ段階を使います。この方法で始めた自動生成は、動画を切り替えても同じようにします。

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
| **显示图片**（画像を表示） | 標準 | なし／少／標準／多。「多」は最多で 10 秒ごとに、変化した画面を一枚残す |
| **润色文本**（文章を校正） | オフ | 軽め／標準／念入り。「標準」は元のプロンプトのまま。自前の LLM が失敗すると、ローカルの FireRedPunc＋Qwen へ自動で切り替え |

一度「生成笔记」を押したあとは、動画を切り替えると自動で生成します。パネルを閉じると自動生成は止まります。

タイムスタンプを隠すと本文にジャンプ用のボタンは出ません。校正していない文字起こしの段落にも、文末の句読点は補われます。

## 文字の出どころ

### プラットフォームの字幕（既定・最速）

YouTube は人が付けた字幕を優先し、無ければ自動生成字幕を使います。Bilibili は `player/wbi/v2` の CC 字幕を使います（`player/v2` はよく別の動画の字幕を返すので使いません）。
自動字幕のスライド窓による重複（同じ文が重なった cue で繰り返し出る）はまとめて取り除きます。
YouTube の字幕はプレーヤーが発行するアクセス用の証票を付けないと取れません。拡張はプレーヤー自身の字幕リクエストから証票を受け取り、無いときはプレーヤーに一度字幕を読み込ませてから字幕のオン・オフを元に戻します。冒頭の広告が流れている間は、広告の終わりを待ちます。
プラットフォームの字幕が取れないとき（字幕が無い、ログインが要る、API が通らない、字幕が動画と合わない など）は、その回だけ自動でローカルの文字起こしに切り替え、パネルには一行だけ知らせます。「文字来源」（文字の出どころ）の設定は変わりません。

### ローカルモデルの文字起こし

まずはローカルの抽出サービスがストリーミングの音声を直接ダウンロードして処理します。ブラウザが直接読める短い動画（3 分・24 MiB まで）は、ブラウザ内でオフラインにデコードします。どちらの近道もプレーヤーの再生を待ちません。音声は 30 秒ずつに切り、設定したローカルの ASR サービスへ渡します。
YouTube・Bilibili のダウンロードに失敗すると、ローカルの補助プログラムは、いまのブラウザでのそのサイトのログイン状態を使ってやり直します。拡張がそのサイトの cookie を渡す先は `127.0.0.1` の補助プログラムだけで、補助プログラムはそれを `yt-dlp` に渡してダウンロードし、終わったら一時ファイルを消します。Edge は拡張の更新後、追加されたサイト cookie の権限について確認してきます。

最初に一度だけ、プロジェクトのフォルダで実行します（Windows / macOS / Linux 共通）：

```sh
npm run local:install
```

Python の `faster-whisper` 実行環境を（無ければ）入れ、軽量なローカル補助プログラムをネイティブメッセージングのホストとして登録し（拡張はこれで補助プログラムを自動で起こせます）、ログイン時に起動するよう設定します。Windows はレジストリとコンパイルした exe のホスト、macOS / Linux はブラウザの `NativeMessagingHosts` フォルダに書き込み、ログイン時の起動はそれぞれ LaunchAgent と XDG autostart で行います。インストーラは Edge / Chrome の設定から読み込み済みのこの拡張を探し出し（展開して読み込んだ拡張の ID は置き場所のフォルダで変わります）、それらにだけ補助プログラムの呼び出しを許すので、先にブラウザで拡張を読み込んでから実行してください。ID を直接渡すこともできます：`node tools/install-local-asr.mjs <拡張の ID>`。
ローカルの文字起こしを選ぶと、補助プログラムは作業の開始時にサービスを自動で起動します。設定ページのボタンで手動でも起動できます。ローカルの文字起こし・校正モデルは 10 分間仕事が無いと終了してメモリを解放し（環境変数 `C2MD_IDLE_SECONDS` で調整可）、次に必要になったときに自動で読み込み直します。初回、多言語の `small`
モデルが無ければ Hugging Face からダウンロードします。ボタンにはダウンロード中・読み込み中・準備完了が表示され、
文字起こしのアドレスとモデル名も自動で入ります。Python 3、Node.js 22、`ffmpeg` が必要で、YouTube・Bilibili の
素早い抽出には `yt-dlp` も要ります。インストールは一度だけ：以後コードを更新しても、補助プログラムが起動時に古くなったホスト登録を自動で直すので、
入れ直しは要りません。プロジェクトのフォルダを動かしたときだけ入れ直してください。アンインストールは `npm run local:uninstall`（`-- --purge` を付けるとダウンロードしたモデルも削除）。
ローカル補助プログラムは `127.0.0.1` だけで待ち受け、ヘルスチェック以外のリクエストにはアクセス用のトークンが要ります。トークンはネイティブメッセージングでこの拡張にだけ渡されるので、
同じマシンのほかの拡張やウェブページがそれを使ってローカルのファイルを読むことはできません。実行時にダウンロードするモデルと実行環境は、版と SHA-256 を固定しており
（`tools/runtime-pins.json`）、照合に通ったものだけを使います。
インストールの最後には、登録したばかりのホスト経由で補助プログラムを起動し、ホストが動かなければその場でエラーにします。拡張が補助プログラムを起こせないときは、どこで途切れたか（未登録、拡張 ID の不一致、Node や補助プログラムのパスが無効 など）を示します。
`npm run local:check-host` はブラウザがホストを見つけられるか、ホストがゼロからサービスを起動できるかを確かめます（既定ではブラウザに読み込まれたすべての複製を確認し、末尾に `-- <拡張の ID>` で指定も可）。`npm run local:check` はローカルのサービスが本当に音声を受け付けるかを確かめます。

すでに動かしている OpenAI 互換の ASR サービスにつなぐこともできます。例えば次のどちらか：

```sh
# whisper.cpp（既定のポートは 8080。パスはちょうど /v1/audio/transcriptions）
./server -m models/ggml-base.bin

# faster-whisper-server（既定のポートは 8000）
faster-whisper-server --model large-v3
```

そのうえで拡張の設定ページの「本地模型转录」（ローカルの文字起こし）にサービスのアドレスとモデル名を入れ、「测试连接」（接続テスト）と「授权访问此地址」（このアドレスへのアクセスを許可）を押します。

ログイン時に起動する補助プログラムを入れていない場合は、抽出サービスを手動で動かすこともできます：

```sh
npm run fast-asr
```

`127.0.0.1:8766` だけで待ち受け、`yt-dlp` でネットワークの音声を取るかローカルのファイルを直接読み、`ffmpeg` で切り分けて、上で設定したローカル ASR を呼びます。Bilibili の既定の CDN が失敗すると予備の経路を試します。ブラウザが直接読める短いメディアには不要です。
YouTube の JavaScript チャレンジは手元の Node.js で処理します。Node.js 22 以上が必要です。

**制限のあるメディアでの代替手段：**

- YouTube・Bilibili でローカル抽出もブラウザでの直接読み込みも失敗したときは、理由を示して止まり、録音には切り替えません。素早く抽出できないそれ以外のメディアだけをプレーヤーから録音します。その場合 1 時間の講義には少なくとも 1 時間かかり、その間**タブを開いたままにしておく**必要があります。
- 録音中は動画が実際に再生されます。音量はかなり下げますが消音にはしません（要素を消音にすると録れるのは無音です）。
- 切れ目には約 40ms のすき間があり、極端な場合は半語ほど欠けることがあります。一片ずつ単独でデコードできるようにするためです。
- サービスが `verbose_json` を返すとタイムスタンプは文単位で正確になり、文章だけを返す場合は一片単位の精度になります。

## 校正の設定

設定ページで校正のモデルを「本机」（ローカル）／「自定义」（カスタム）で切り替えられます。以前の設定は入力済みのリモートのモデルをそのまま使い続けます。リモートが未入力なら、「润色文本」にチェックを入れるとローカルの [FireRedPunc](https://huggingface.co/FireRedTeam/FireRedPunc) と [Qwen3.5-2B の Q4 量子化版](https://huggingface.co/SoAIHQ/Qwen3.5-2B-GGUF) を起動します。初回はモデルをダウンロードします。VRAM 8 GB の機械では、文字起こしのモデルとメモリを取り合わないよう一ブロックずつ処理します。

OpenAI 互換の `/chat/completions` エンドポイントなら何でも使えます。

設定ページでは、サービスのアドレス（`/v1` まで）、API キー（ローカルのサービスなら空欄）、モデル名を入れます。
そのあと「授权访问此地址」を押してください。OpenAI 互換のエンドポイントはほぼ CORS ヘッダーを返さないため、この手順が無いとリクエストが
ブラウザに止められます。キーはブラウザの local storage にだけ保存され、**同期されません**。

任意で次の二つを書いておくと効果があります：

- **术语表（用語集）**：一行に一語。同音の誤りが一番多いのはいつも固有名詞で、一行書けば直ります。
- **自定义校对指令（独自の校正指示）**：空欄なら組み込みの指示を使います。出力形式の制約は拡張が必ず付け足すので、変えられません。

### なぜ「ブロックに分けて送る」のか

一文ずつでも全文まとめてでもなく、**段落の区切り**でブロックに分け（既定は 20 段落／1,200 字）、並行して送ります：

- 一文ずつ：モデルに前後の文脈が見えず、文の区切りを直せません。1 時間の講義だと千回単位のリクエストになります。
- 全文まとめて：文脈の長さを超え、途中で失敗すれば全部やり直し、長い出力は内容がずれやすくなります。
- ブロックごと：ブロックの中は連続した完全な段落で、ブロック同士は並行して動き、互いに影響しません。各ブロックには**前のブロックの最後の文**も
  読み取り専用の文脈として付けるので、ブロックの境目でも文章がつながります。

どのブロックにも**id ごとに一件ずつ返す**よう求め、id が合わなければそのブロックは原文のまま残します。最悪でも「ここは校正されなかった」で済み、
「文章がずれた」ことにはなりません。

「润色文本」を外すとすぐに原文が表示されます。原文は常に残してあるので、原文を見るのにモデルへ問い合わせ直す必要はありません。

## インストール

ストアにはまだ出していません。「パッケージ化されていない拡張機能を読み込む」を使います：

1. `chrome://extensions`（Edge は `edge://extensions`）を開き、右上の**デベロッパー モード**をオンにする。
2. **パッケージ化されていない拡張機能を読み込む**を押し、このリポジトリのフォルダを選ぶ。
3. YouTube か Bilibili で動画を開き、ツールバーのアイコンを押す。

Chrome/Edge 116 以上が必要です。

**対応サイト**：YouTube（`/watch`）、Bilibili（`/video/`）、そしてページ上に `<video>` がある
あらゆるページ（後者はポップアップで一度許可を押す必要があります）。ブラウザで直接開いたローカルの動画ファイルにも使えます。これはまさに
course2md の「ローカル録画」の場面です。

## 開発

ビルド不要：バンドラーもビルド成果物もありません。コンテンツスクリプトは動的 `import()` で ESM を読み込みます。

```sh
npm run check        # マニフェスト自己点検＋型検査＋単体テスト＋レイアウト検証を一度に（CI と同じ）
npm test             # 単体テストだけ（純粋なロジック、node --test）
npm run check:manifest # マニフェスト自己点検：参照先のファイルがある、モジュールの閉包がページから取れる、権限が合っている
npm run typecheck    # tsc --checkJs で src/ を検査（コードは JS のまま、ビルド不要）
npm run check:layout # 幾何の検証だけ：パネルのレイアウト、ボタンの塗り、横はみ出しが無いこと
npm run check:sites  # 本物の YouTube / Bilibili のページで本物の拡張を動かす（ネットワークが必要、CI には入れない）
npm run check:image  # 場面が三回変わる実際の動画で、画像密度の四段階を確かめる
npm run shots        # 各状態のスクリーンショット → tools/shots/
npm run pack         # まず全検査を通し、通ったときだけ二つの配布パッケージを dist/ に出力
npm run media        # 本物の YouTube のページでこの拡張を動かし、README の実演素材を録る → docs/media/
npm run icons        # 拡張のアイコンを作り直す（自前のラスタライズ＋自前の PNG エンコード、ネイティブ依存なし）
npm run serve        # 自己テスト用サーバー：http://127.0.0.1:8787/tools/selftest.html
```

`tools/` の中身は開発専用で、製品としては動きません。自己テスト台に
`tools/chrome-mock.js` が要るのは、Chrome 137 で `--load-extension` が廃止されたためです。Chrome で
スクリーンショットを撮るには `chrome.*` に代役を立てるしかなく、製品のコードにスクリーンショットのための裏口は一切ありません。

`npm run check:manifest` については一言：マニフェストのパスを一つ間違えると、Chrome はその部品だけを
**黙って無効に**します。しかもコンテンツスクリプトが `import(chrome.runtime.getURL(…))` で動的に読み込むモジュールは
マニフェストに現れないので、`web_accessible_resources` で覆えていないと実行時にクロスオリジンのエラーになります。
この検査はコンテンツスクリプトのモジュールの閉包を計算して一つずつ照合します。開発中に実際、
「パネルが参照する `src/ui/controls.js` がページに公開されていない」という本物の欠陥を捕まえました。

より詳しい設計の説明（course2md との項目ごとの対照、ブロック単位の校正の取捨の全体、kill-ai-slop との
一項目ずつの対照、はまった落とし穴）は [DESIGN.md](DESIGN.md)（中国語）にあります。

## 既知の限界

- **上流の API は変わります。** YouTube の字幕の証票も Bilibili の字幕 API も本物のページで確かめてありますが（`npm run check:sites`）、
  いつ変わってもおかしくなく、`src/adapters/` が最も手入れの要る部分です。
- **ブラウザ内の WebGPU による ASR はまだありません。** いまの素早い処理はブラウザ内のオフラインデコードかローカルの抽出サービスに頼っています。WebGPU には、検証できるモデルと推論の実行環境を拡張に同梱する必要があります。
- **スクリーンショットは、ローカル補助プログラムが動画ファイルを取れることが前提です。** `yt-dlp` と `ffmpeg` でオフラインにフレームを取り出し、ページの再生位置には触れません。メディアをダウンロードできないときは図入りの書き出しを止めて理由を示します。「多」は話している時間帯の中で最多 10 秒ごとに画面を確かめ、類似度 0.85 のしきい値で重複を除きます。
- **DRM のかかった動画は文字起こしできません**：`captureStream()` で音声トラックが取れないためです。
- 実際の再生速度で進める必要があるのは、プレーヤーから録音する代替手段だけです。

## ライセンス

MIT。全文は `LICENSE` にあります。サードパーティの部品（同梱のもの、実行時にダウンロードするもの）とそのライセンスは `THIRD_PARTY_NOTICES.md` にまとめてあります。
デザイントークンは kill-ai-slop（Apache-2.0）から取り、値はそのまま残してあります。出典は
`src/ui/tokens.css` のコメントにあります。繁体字・簡体字の変換には opencc-js を使っており、そのライセンスファイルは `src/vendor/` に同梱しています。

この README の GIF とスクリーンショットは、どれも `npm run media` がこの拡張を本物の YouTube のページで動かして録ったもので、ページの中身はその場で生成された本物の結果です。GIF の光標と寄り引きは、実際の操作の位置と時刻をもとに後から合成しています。
実演の講義は MIT OpenCourseWare の《6.0001 Introduction to Computer Science and Programming in Python》（Fall 2016、Dr. Ana Bell）で、
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) に基づいて使っています。
横幕の YouTube と bilibili のロゴは Wikimedia Commons（パブリックドメイン）から取り、対応サイトを示すためだけに使っています。いずれも各所有者の商標です。
