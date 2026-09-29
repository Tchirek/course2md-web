// ページやブラウザには存在するが TypeScript 標準の宣言に無いもの。checkJs 用。

/** YouTube のプレーヤー要素（#movie_player）にページのスクリプトが生やすメソッド。 */
interface YouTubePlayerElement extends HTMLElement {
  getPlayerResponse(): any;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getOption(module: string, option: string): any;
  setOption(module: string, option: string, value: any): void;
  loadModule(module: string): void;
  unloadModule(module: string): void;
}

interface Window {
  __c2mdBooted?: boolean;
  __c2mdController?: any;
  /** B 站ページの初期状態と再生情報。 */
  __INITIAL_STATE__?: any;
  __playinfo__?: any;
}

interface HTMLMediaElement {
  /** 仕様にはあるが lib.dom にまだ無い。 */
  captureStream(): MediaStream;
}
