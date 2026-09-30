//! 内容スクリプトの小さな道具：後台への要求と、クリップボードへの複製。

/**
 * 通过后台发消息；后台没响应时抛一个能看懂的错。
 * @param {{type: string, payload?: object}} message
 * @returns {Promise<any>} 后台返回的值（类型随请求而不同）
 */
export async function send(message) {
  let reply;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch (error) {
    // 拡張が読み込み直されると、開いていたページの内容スクリプトは後台とつながらなくなる
    if (/context invalidated/i.test(String(/** @type {{message?: unknown}} */ (error)?.message ?? error))) {
      throw new Error('扩展刚更新过，请刷新页面后重试。');
    }
    throw error;
  }
  if (!reply) throw new Error('扩展后台没有响应。刷新页面后重试。');
  if (!reply.ok) throw new Error(reply.error ?? '未知错误');
  return reply.value;
}

/**
 * 复制到剪贴板。
 * navigator.clipboard 需要文档处于聚焦状态，YouTube 的某些状态下会拒绝；
 * 所以保留一条 execCommand 的兜底路径。
 * @param {string} text
 */
export async function copyText(text) {
  if (!text) return false;
  let area;
  try {
    area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy');
    if (ok) return true;
  } catch {
    /* 尝试扩展剪贴板权限 */
  } finally {
    area?.remove();
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
