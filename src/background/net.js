//! バックグラウンドの要求で共用する期限（タイムアウト）処理。
//!
//! 期限は本文の読み取りまで含めて一つの AbortController で管理し、期限切れでは下の
//! fetch を本当に中止する（Promise だけを先に reject して要求を裏で走らせ続けない）。
//! 期限切れは TimeoutError、呼び出し側の signal による中止は AbortError のままにして、
//! 「超時」と「利用者の取消」を取り違えない。

export class TimeoutError extends Error {
  constructor(ms) {
    super(`请求超时（${Math.round(ms / 1000)} 秒没有响应）`);
    this.name = 'TimeoutError';
  }
}

/**
 * fetch して consume(response, keepAlive) で本文まで読む。全体を ms の期限で包む。
 * keepAlive() を呼ぶと期限を張り直す（ストリームを一片受け取るたびに呼び、
 * 「総時間」ではなく「無応答の時間」で打ち切る）。
 *
 * @template T
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} ms
 * @param {(response: Response, keepAlive: () => void) => Promise<T>} consume
 * @returns {Promise<T>}
 */
export async function timedRequest(url, init, ms, consume) {
  const deadline = new AbortController();
  let timer;
  const keepAlive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => deadline.abort(new TimeoutError(ms)), ms);
  };
  keepAlive();
  const signal = init?.signal ? AbortSignal.any([deadline.signal, init.signal]) : deadline.signal;
  try {
    const response = await fetch(url, { ...init, signal });
    return await consume(response, keepAlive);
  } catch (error) {
    // 本文の読み取り中に中止されると、どの段で落ちたかで例外の形が変わる。期限切れなら
    // 形によらず TimeoutError に揃える
    if (deadline.signal.aborted && !init?.signal?.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
