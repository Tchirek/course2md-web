//! 跨模块共用的领域错误。单独放 core：adapters 与 content 都要引用，
//! 放任何一方都会造成互相导入的环。

/** 源缺失：用户配置问题，不是崩溃。UI 要给出可操作的下一步。 */
export class MissingSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingSourceError';
    this.actionable = true;
  }
}
