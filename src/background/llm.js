//! LLM 调用：OpenAI 兼容的 /chat/completions。
//!
//! 为什么在服务 worker 里发请求而不是内容脚本：
//! 内容脚本的 fetch 受**页面 CSP** 的 connect-src 约束。YouTube 的 CSP 不会
//! 允许 api.deepseek.com，请求会被直接拦掉。后台的 fetch 只受扩展自己的权限
//! 约束（host_permissions），完全绕开页面策略。

/** 与 course2md 一致：校对任务不需要创造性，温度取 0。 */
const TEMPERATURE = 0;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * 发一次对话请求。
 *
 * 重试策略：网络错误与 429/5xx 重试；4xx（除 429）是请求本身的问题，
 * 立刻失败并把服务端的原话带回去——用户配错模型名时需要看到真实原因。
 *
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {{role:string, content:string}[]} args.messages
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ok:true, content:string, usage?:object}|{ok:false, error:string, retryable:boolean}>}
 */
export async function chat({ baseUrl, apiKey, model, messages, signal, onDelta }) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages,
    temperature: TEMPERATURE,
    stream: Boolean(onDelta),
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let lastError = '未知错误';
  for (let attempt = 1; attempt <= (onDelta ? 1 : MAX_ATTEMPTS); attempt++) {
    try {
      const res = await withTimeout(
        fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        }),
        REQUEST_TIMEOUT_MS,
      );

      if (!res.ok) {
        const detail = await readErrorBody(res);
        lastError = `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) return { ok: false, error: lastError, retryable: false };
        await backoff(attempt);
        continue;
      }

      let content;
      let usage;
      if (onDelta) {
        content = await readStream(res, onDelta);
      } else {
        const json = await res.json();
        content = json?.choices?.[0]?.message?.content;
        usage = json?.usage;
      }
      if (typeof content !== 'string') {
        return { ok: false, error: '回复里没有 choices[0].message.content', retryable: false };
      }
      return { ok: true, content, usage };
    } catch (err) {
      if (err?.name === 'AbortError') return { ok: false, error: '已取消', retryable: false };
      lastError = describeFetchError(err, endpoint);
      await backoff(attempt);
    }
  }
  return { ok: false, error: lastError, retryable: true };
}

async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  while (true) {
    const { value, done } = await withTimeout(reader.read(), REQUEST_TIMEOUT_MS);
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    pending = pending.replace(/\r\n/g, '\n');
    let cut;
    while ((cut = pending.indexOf('\n\n')) >= 0) {
      const event = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (event.error) throw new Error(event.error.message ?? String(event.error));
        const delta = event?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          content += delta;
          onDelta(delta);
        }
      }
    }
    if (done) break;
  }
  return content;
}

/** 把 fetch 的失败翻译成用户能照着修的提示。 */
export function describeFetchError(err, endpoint) {
  const message = String(err?.message ?? err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return (
      `连不上 ${endpoint}。检查地址是否正确；` +
      `若地址在扩展权限之外，请到设置页点「授权访问此地址」；` +
      `若服务端未开启 CORS 也没关系——本扩展走后台请求，不受页面限制。`
    );
  }
  return message;
}

async function readErrorBody(res) {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const json = JSON.parse(text);
      const msg = json?.error?.message ?? json?.message ?? json?.detail;
      if (typeof msg === 'string') return msg.slice(0, 300);
    } catch {
      /* 不是 JSON，直接用原文 */
    }
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

function backoff(attempt) {
  // 简单指数退避：400ms / 1200ms
  const ms = 400 * 3 ** (attempt - 1);
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('请求超时');
      err.name = 'AbortError';
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 探测一个端点是否可用：拉一次 /models，失败就退化成发一条最小对话请求。
 * 设置页的「测试连接」用它。
 *
 * @param {object} args 同 chat
 * @returns {Promise<{ok:boolean, message:string, models?:string[]}>}
 */
export async function testConnection({ baseUrl, apiKey, model }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  try {
    const res = await withTimeout(
      fetch(`${base}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      }),
      15_000,
    );
    if (res.ok) {
      const json = await res.json();
      const ids = (json?.data ?? []).map((m) => m?.id).filter(Boolean);
      if (ids.length && model && !ids.includes(model)) {
        return {
          ok: true,
          message: `端点可用，但它列出了 ${ids.length} 个模型，其中没有「${model}」。确认模型名拼写。`,
          models: ids,
        };
      }
      return { ok: true, message: `端点可用${ids.length ? `，共 ${ids.length} 个模型` : ''}。`, models: ids };
    }
  } catch {
    /* /models 不可用很正常，继续用对话请求探测 */
  }

  const probe = await chat({
    baseUrl: base,
    apiKey,
    model,
    messages: [
      { role: 'system', content: '只回复两个字：可用' },
      { role: 'user', content: '测试' },
    ],
  });
  if (probe.ok) return { ok: true, message: `对话请求成功，模型回复：${probe.content.trim().slice(0, 40)}` };
  return { ok: false, message: probe.error };
}
