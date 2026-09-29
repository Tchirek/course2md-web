//! 跨模块共用的领域错误。单独放 core：adapters 与 content 都要引用，
//! 放任何一方都会造成互相导入的环。

/** 源缺失：用户配置问题，不是崩溃。UI 要给出可操作的下一步。 */
export class MissingSourceError extends Error {
  /**
   * @param {string} message
   * @param {{brief?: string}} [options] brief：平台字幕が使えず本機の文字起こしへ自動で
   *   切り替えるときの短い理由（「……，已自动改用本地模型转录」の前半）
   */
  constructor(message, { brief } = {}) {
    super(message);
    this.name = 'MissingSourceError';
    this.actionable = true;
    if (brief) this.brief = brief;
  }
}
