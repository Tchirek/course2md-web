//! 把各种异常转成「用户能照着做点什么」的界面状态。
//!
//! 原则：区分「你没配置」和「它坏了」。前者要给下一步按钮，后者要给真实原因
//! ——尤其是 LLM / ASR 报回来的原话，用户改配置时需要看到它。

/**
 * @param {unknown} error
 * @returns {{title:string, body:string, options?:string, detail?:string}}
 */
export function toErrorState(error) {
  const message = String(error?.message ?? error ?? '未知错误').trim();

  if (error?.name === 'AbortError') {
    return { title: '已取消', body: '这次生成被中止了，已经取到的内容不会保留。' };
  }

  // 用户还没配置 / 页面没有可用来源——这两种不是「故障」
  if (error?.actionable) {
    return { title: '取不到文字', body: message };
  }

  if (error?.name === 'NotAllowedError' || /permission|权限/i.test(message)) {
    return {
      title: '缺少权限',
      body: `${message}\n如果是本机 ASR 或 LLM 地址，请到设置页点「授权访问此地址」。`,
      options: 'llm',
    };
  }

  if (/连不上|Failed to fetch|NetworkError|Load failed|超时/i.test(message)) {
    return {
      title: '连不上服务',
      body: message,
      options: /audio\/transcriptions|ASR|whisper/i.test(message) ? 'asr' : 'llm',
    };
  }

  if (/^HTTP \d/.test(message) || /转写失败|润色/.test(message)) {
    return {
      title: '服务返回了错误',
      body: message,
      options: /转写/.test(message) ? 'asr' : 'llm',
    };
  }

  return { title: '出错了', body: message || '没有更多信息。可以在扩展的「详情」里看后台日志。' };
}
