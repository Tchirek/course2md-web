//! 内容脚本控制器：持有状态、跑管线、渲染面板、响应弹窗。
//!
//! 状态放在这里而不是后台，所以 service worker 被回收、弹窗被关掉、
//! 用户切走标签页，都不会影响正在进行的工作。

import { pickAdapter, siteLabel } from '../adapters/index.js';
import { toErrorState } from './errors.js';
import { Panel } from './panel.js';
import { visualSections, captureSectionImages } from './visual.js';
import { buildDoc, toMarkdown, toPlainText, fileNameFor } from '../core/format.js';
import {
  runSubtitlePipeline, runAsrPipeline, polishSegments, finalize, organize,
  MissingSourceError, AbortError,
} from './pipeline.js';

const POLL_MS = 1500;

class Controller {
  constructor() {
    this.adapter = pickAdapter();
    this.settings = null;
    this.meta = null;
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.status = 'idle';
    this.error = null;
    this.stageLabel = '';
    this.abort = null;
    this.polishState = { hasResult: false, running: false, done: 0, total: 0, summary: '' };
    this.urlKey = this.currentUrlKey();

    this.panel = new Panel({
      onSettings: (patch) => this.patchSettings(patch),
      onSeek: (sec) => this.seek(sec),
      onCopy: () => this.copyMarkdown(),
      onCopyText: () => this.copyPlainText(),
      onDownload: () => this.download(),
      onRerun: () => this.run(),
      onRepolish: () => this.repolish(),
      onOptions: (section) => this.openOptions(section),
      onClose: () => this.panel.unmount(),
      onSwitchToAsr: () => this.switchToAsr(),
    });
  }

  // ---------- 生命周期 ----------

  async init() {
    this.settings = await send({ type: 'settings.load' }).catch(() => null);
    if (!this.settings) {
      // 后台还没起来时用默认值兜底，界面不至于空白
      const { DEFAULT_SETTINGS } = await import('../core/settings.js');
      this.settings = structuredClone(DEFAULT_SETTINGS);
    }

    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      const handler = this.MESSAGES[message?.type];
      if (!handler) return false;
      Promise.resolve(handler.call(this, message.payload ?? {}))
        .then((value) => respond({ ok: true, value }))
        .catch((error) => respond({ ok: false, error: toErrorState(error) }));
      return true;
    });

    // 设置变了（用户在弹窗或设置页改的）就即时反映到面板
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const next = changes.settings.newValue;
      if (!next) return;
      this.settings = next;
      this.panel.setState({ settings: this.settings });
      if (this.settings.showPanel && this.doc) this.panel.mount();
    });

    // SPA 换视频：YouTube 与 B 站都是不刷新页面换内容的
    setInterval(() => this.checkNavigation(), POLL_MS);

    // 有缓存内容就恢复出来（后退/前进回来时不用重新抓一遍）
    const cached = await this.loadCache();
    if (cached) {
      this.built = cached.built;
      this.previewSections = cached.previewSections ?? visualSections(cached.sections, cached.meta.duration);
      this.meta = cached.meta;
      this.doc = buildDoc({ ...this.meta, source: cached.stats.source }, cached.sections);
      this.status = 'ready';
      this.polishState.hasResult = Boolean(cached.polished);
      if (this.settings.showPanel) this.panel.mount();
    }
    this.broadcast();
  }

  currentUrlKey() {
    const loc = location;
    return `${this.adapter.id}:${loc.origin}${loc.pathname}${loc.search}`;
  }

  checkNavigation() {
    const key = this.currentUrlKey();
    if (key === this.urlKey) return;
    this.abort?.abort();
    this.urlKey = key;
    // 换视频了：清干净，避免把上一个视频的笔记留在屏幕上
    this.adapter = pickAdapter();
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.meta = null;
    this.status = 'idle';
    this.error = null;
    this.polishState = { hasResult: false, running: false, done: 0, total: 0, summary: '' };
    this.panel.setState(this.panelState());
  }

  // ---------- 消息 ----------

  MESSAGES = {
    'c2md.ping': async () => ({
      ready: true,
      site: this.adapter.id,
      siteLabel: siteLabel(this.adapter.id),
      hasVideo: Boolean(this.adapter.video()),
      status: this.status,
    }),

    'c2md.status': async () => {
      if (!this.meta) {
        this.meta = await this.safeMeta();
        this.broadcast();
      }
      return this.summaryState();
    },

    'c2md.run': () => {
      this.run().catch((error) => {
        this.status = 'error';
        this.error = toErrorState(error);
        this.broadcast();
      });
      return { status: this.status };
    },
    'c2md.cancel': async () => this.cancel(),
    'c2md.polish': async () => this.repolish(),
    'c2md.showPanel': async () => {
      this.panel.mount();
      return { shown: true };
    },
    'c2md.hidePanel': async () => {
      this.panel.unmount();
      return { shown: false };
    },
    'c2md.seek': async ({ seconds }) => ({ sought: await this.seek(seconds) }),
    'c2md.copy': async () => ({ copied: await this.copyMarkdown() }),
    'c2md.download': async () => this.download(),
    'c2md.openOptions': async ({ section }) => this.openOptions(section),
  };

  summaryState() {
    return {
      status: this.status,
      site: this.adapter.id,
      siteLabel: siteLabel(this.adapter.id),
      settings: this.settings,
      meta: this.meta
        ? {
            title: this.meta.title,
            uploader: this.meta.uploader,
            duration: this.meta.duration,
            url: this.meta.url,
          }
        : null,
      stats: this.built?.stats ?? null,
      segmented: this.built ? this.built.segments.length : 0,
      polish: { ...this.polishState },
      error: this.error,
      warnings: this.built?.warnings ?? [],
      stageLabel: this.stageLabel,
    };
  }

  panelState() {
    return { ...this.summaryState(), sections: this.previewSections };
  }

  broadcast(updatePanel = true) {
    if (updatePanel) this.panel.setState(this.panelState());
    // 弹窗可能开着，也可能没开；没开时这个 sendMessage 会静默失败
    chrome.runtime.sendMessage({ type: 'c2md.state', payload: this.summaryState() }).catch(() => {});
  }

  // ---------- 管线 ----------

  async safeMeta(adapter = this.adapter) {
    try {
      return await adapter.meta();
    } catch (error) {
      return { title: document.title, uploader: '', duration: 0, url: location.href, site: adapter.id, language: '' };
    }
  }

  onProgress(stage, info = {}) {
    if (info.message) this.stageLabel = info.message;
    this.status = 'running';
    this.panel.setState({ status: 'running', stageLabel: this.stageLabel });
    this.broadcast(false);
  }

  async run() {
    if (this.status === 'running') return { status: 'running' };

    this.abort?.abort();
    this.abort = new AbortController();
    const runAbort = this.abort;
    const adapter = this.adapter;
    this.status = 'running';
    this.error = null;
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.polishState = { hasResult: false, running: false, done: 0, total: 0, summary: '' };
    this.stageLabel = '正在读取页面信息';
    this.panel.mount();
    this.broadcast();

    try {
      const meta = await this.safeMeta(adapter);
      meta.chapters = await adapter.chapters(meta).catch(() => []);
      meta.chapters = meta.chapters ?? [];
      if (runAbort.signal.aborted) throw new AbortError();

      const common = {
        adapter,
        meta,
        settings: this.settings,
        signal: runAbort.signal,
        onProgress: (stage, info) => {
          if (this.abort === runAbort && !runAbort.signal.aborted) this.onProgress(stage, info);
        },
        onPartial: (events) => {
          if (this.abort !== runAbort || runAbort.signal.aborted) return;
          const partial = organize([...events].sort((a, b) => a.start - b.start), meta);
          this.meta = meta;
          this.previewSections = visualSections(partial.sections, meta.duration);
          this.broadcast();
        },
      };

      const built = this.settings.source === 'asr'
        ? await runAsrPipeline(common)
        : await runSubtitlePipeline(common);

      if (runAbort.signal.aborted) throw new AbortError();
      this.meta = meta;
      this.built = built;

      this.previewSections = visualSections(this.built.sections, this.meta.duration);
      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      this.broadcast(); // 文字先出现，截图随后补齐。
      await captureSectionImages(adapter.video(), this.previewSections, this.panel.host, runAbort.signal).catch(() => {});
      if (runAbort.signal.aborted) throw new AbortError();
      this.broadcast();

      // 勾了润色且配置齐全，就在同一次流程里顺带跑掉
      if (this.settings.polish) {
        await this.runPolish(runAbort.signal);
      }
      if (runAbort.signal.aborted) throw new AbortError();

      this.doc = finalize(this.built, this.meta, this.settings);
      this.status = 'ready';
      this.stageLabel = '';
      await this.saveCache();
    } catch (error) {
      if (this.abort !== runAbort) return { status: 'stale' };
      if (error instanceof AbortError || runAbort.signal.aborted) {
        this.status = 'idle';
        this.error = null;
        this.built = null;
        this.previewSections = [];
      } else {
        this.status = 'error';
        this.error = toErrorState(error);
        if (error instanceof MissingSourceError && this.settings.source === 'subtitle') {
          this.error.switchToAsr = true;
        }
      }
      this.stageLabel = '';
    }

    if (this.settings.showPanel) this.panel.mount();
    this.broadcast();
    return { status: this.status, error: this.error };
  }

  async runPolish(signal = this.abort?.signal) {
    if (!this.built?.segments?.length) return;
    this.polishState = { hasResult: this.polishState.hasResult, running: true, done: 0, total: 0, summary: '' };
    this.panel.setState(this.panelState());

    const result = await polishSegments({
      segments: this.built.segments,
      sectionIndexOf: this.built.sectionIndexOf,
      meta: this.meta,
      settings: this.settings,
      signal,
      onProgress: (done, total) => {
        this.polishState = { ...this.polishState, running: true, done, total };
        this.panel.setState({ polish: this.polishState });
        this.broadcast(false);
      },
    });

    if (signal?.aborted) throw new AbortError();

    const summary = summarizePolish(result);
    this.polishState = { hasResult: true, running: false, done: result.chunks, total: result.chunks, summary };
    this.doc = finalize(this.built, this.meta, this.settings);
    await this.saveCache();
  }

  async repolish() {
    if (!this.built) return { status: 'none' };
    if (!this.settings.llm.baseUrl || !this.settings.llm.model) {
      this.error = {
        title: '还没接入 LLM',
        body: '润色需要你自己填一个 OpenAI 兼容的地址与模型名。插件不内置任何模型，也不替你选服务商。',
        options: 'llm',
      };
      this.broadcast();
      return { status: 'unconfigured' };
    }
    this.polishState = { ...this.polishState, running: true };
    this.panel.setState(this.panelState());
    try {
      await this.runPolish();
      this.error = null;
    } catch (error) {
      this.error = toErrorState(error);
    }
    this.broadcast();
    return { status: 'done' };
  }

  cancel() {
    this.abort?.abort();
    this.status = 'idle';
    this.stageLabel = '';
    this.built = null;
    this.previewSections = [];
    this.doc = null;
    this.broadcast();
    return { cancelled: true };
  }

  async switchToAsr() {
    await this.patchSettings({ source: 'asr' });
    this.settings.source = 'asr';
    return this.run();
  }

  // ---------- 动作 ----------

  async seek(seconds) {
    const ok = await this.adapter.seek(seconds).catch(() => false);
    if (!ok) return false;
    // 短暂标一下当前段落，用户回到页面时知道跳到哪了
    if (this.panel.isMounted) {
      for (const p of this.panel.scope.querySelectorAll('.c2md-para[data-active]')) {
        delete p.dataset.active;
      }
      const target = this.panel.scope.querySelector(`.c2md-para[data-start="${Math.floor(seconds)}"]`)
        ?? null;
      if (target) {
        target.dataset.active = 'true';
        setTimeout(() => delete target.dataset.active, 1600);
      }
    }
    return true;
  }

  markdown() {
    if (!this.doc) return '';
    return toMarkdown(this.doc, {
      timestamps: this.settings.showTimestamps,
      links: this.settings.clickToSeek,
    });
  }

  plainText() {
    if (!this.doc) return '';
    return toPlainText(this.doc, { timestamps: this.settings.showTimestamps });
  }

  async copyMarkdown() {
    return copyText(this.markdown());
  }

  async copyPlainText() {
    return copyText(this.plainText());
  }

  async download() {
    if (!this.doc) return { saved: false };
    try {
      return await send({
        type: 'file.save',
        payload: {
          filename: fileNameFor(this.doc.meta.title, 'md'),
          text: this.markdown(),
        },
      });
    } catch (error) {
      this.error = toErrorState(error);
      this.panel.setState(this.panelState());
      return { saved: false };
    }
  }

  async openOptions(section) {
    return send({ type: 'ui.openOptions', payload: { section } });
  }

  async patchSettings(patch) {
    const reply = await send({ type: 'settings.save', payload: { patch } });
    if (reply?.settings) {
      this.settings = reply.settings;
      this.broadcast();
    }
    return reply;
  }

  // ---------- 缓存 ----------

  cacheKey() {
    return `cache:${this.adapter.id}:${location.pathname}${location.search}`;
  }

  /** 存最近一次的笔记。存不进去（配额满）也不算错，只是下次要重新抓。 */
  async saveCache() {
    try {
      await chrome.storage.session?.set({
        [this.cacheKey()]: {
          meta: this.meta,
          sections: this.built.sections,
          previewSections: this.previewSections,
          stats: this.built.stats,
          polished: this.polishState.hasResult,
          savedAt: Date.now(),
        },
      });
    } catch {
      /* session 存储不可用或超配额，忽略 */
    }
  }

  async loadCache() {
    try {
      const key = this.cacheKey();
      const stored = await chrome.storage.session?.get(key);
      const entry = stored?.[key];
      if (!entry) return null;
      // 一小时后过期：视频可能改了，旧笔记容易误导
      if (Date.now() - (entry.savedAt ?? 0) > 3600_000) return null;
      return entry;
    } catch {
      return null;
    }
  }
}

/** 通过后台发消息；后台没响应时抛一个能看懂的错。 */
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply) throw new Error('扩展后台没有响应。刷新页面后重试。');
  if (!reply.ok) throw new Error(reply.error ?? '未知错误');
  return reply.value;
}

/**
 * 复制到剪贴板。
 * navigator.clipboard 需要文档处于聚焦状态，YouTube 的某些状态下会拒绝；
 * 所以保留一条 execCommand 的兜底路径。
 */
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 走兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function summarizePolish(result) {
  if (!result.chunks) return '没有需要润色的段落。';
  const parts = [`润色 ${result.chunks} 块`];
  if (result.removed) parts.push(`删除语气词 ${result.removed} 处`);
  if (result.failed) {
    parts.push(`${result.failed} 块保留原文`);
    const first = result.errors[0];
    if (first) parts.push(`第一个失败：${first}`);
  }
  return `${parts.join(' · ')}。`;
}

export async function start() {
  const controller = new Controller();
  window.__c2mdController = controller;
  await controller.init();
  return controller;
}
