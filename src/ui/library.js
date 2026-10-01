import { fromUpstream, toMarkdown, seekUrl, fileNameFor } from '../core/format.js';
import { fmtTs } from '../core/time.js';
import { applyTheme } from './controls.js';
import { withDefaults } from '../core/settings.js';

/** @template {HTMLElement} T @param {string} id @returns {T} */
function byId(id) { return /** @type {T} */ (document.getElementById(id)); }
/** @type {HTMLSelectElement} */
const librarySelect = byId('libraries');
/** @type {HTMLSelectElement} */
const versions = byId('versions');
const params = new URLSearchParams(location.search);
let library = params.get('library') ?? '', course = params.get('course') ?? '', version = params.get('version') ?? '';
/** @type {import('../core/format.js').Doc|null} */
let doc = null;
/** @type {{course: string, title: string, folder: string, duration: number, partial: boolean}[]} */
let courses = [];
let generation = 0, matchIndex = -1;
let engineAvailable = false;
/** @type {HTMLElement[]} */
let matches = [];
/** @type {ReturnType<typeof setTimeout>|undefined} */
let positionTimer;
/** @type {IntersectionObserver|null} */
let imagesObserver = null;

/** @param {object} message @returns {Promise<any>} */
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw Object.assign(new Error(reply?.error ?? '扩展后台没有响应'), { setupRequired: reply?.setupRequired });
  return reply.value;
}
/** @param {string} action @param {object} [input] */
function request(action, input = {}) { return send({ type: 'library.request', payload: { action, input: { library, course, version, ...input } } }); }
/** @param {unknown} text @param {boolean} [error] */
function status(text, error = false) { byId('status').textContent = String(text ?? ''); byId('status').dataset.error = String(error); }
/** @param {() => Promise<unknown>} task */
async function run(task) { try { await task(); } catch (error) {
  status(/** @type {Error} */ (error).message, true);
  if (/** @type {{setupRequired?: boolean}} */ (error).setupRequired) byId('helper-setup').hidden = false;
} }
/** @param {string} url */
function videoUrl(url) { try { return ['https:', 'http:'].includes(new URL(url).protocol) ? url : ''; } catch { return ''; } }
/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [text] @param {string} [className] */
function node(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }

async function discover() {
  status('正在连接本机课程库');
  const result = await request('discover');
  byId('helper-setup').hidden = true;
  const stored = await chrome.storage.local.get('selectedLibrary');
  library ||= typeof stored.selectedLibrary === 'string' ? stored.selectedLibrary : '';
  librarySelect.replaceChildren(new Option('选择课程库', ''));
  for (const item of result.libraries) {
    const option = new Option(`${item.name}${item.available ? '' : '（未连接）'}`, item.id);
    option.disabled = !item.available;
    librarySelect.append(option);
  }
  if (!result.libraries.some(/** @param {any} item */ (item) => item.id === library && item.available)) library = '';
  if (!library) library = result.defaultLibrary ?? result.libraries.find(/** @param {any} item */ (item) => item.available)?.id ?? '';
  librarySelect.value = library;
  status(result.warnings.join('\n'));
  if (!library) { /** @type {HTMLDetailsElement} */ (byId('connection')).open = true; return; }
  await chrome.storage.local.set({ selectedLibrary: library });
  await list();
  if (course) await read();
}

async function list() {
  const selected = library;
  status('正在读取课程库');
  const result = await request('list');
  if (library !== selected) return;
  courses = result.courses;
  renderCourses();
  status(result.warnings.join('\n') || (courses.length ? '' : '这个课程库还没有可读笔记。'));
}

/** @param {string} [path] */
async function connectEngine(path) {
  const result = await request('engine', path ? { path } : {});
  engineAvailable = result.available;
  /** @type {HTMLInputElement} */ (byId('engine-path')).value = result.path;
  byId('engine-status').textContent = result.version || result.message;
  byId('engine-install').hidden = engineAvailable;
  /** @type {HTMLButtonElement} */ (byId('native-export')).disabled = !doc;
  byId('native-export').textContent = engineAvailable ? '导出图文' : '安装 CLI 并导出';
}

async function installEngine() {
  status('正在安装 course2md CLI');
  await request('engine', { install: true });
  await connectEngine();
  status('CLI 已就绪');
}

function renderCourses() {
  const query = /** @type {HTMLInputElement} */ (byId('filter')).value.trim().toLocaleLowerCase();
  const list = byId('courses');
  list.replaceChildren();
  for (const item of courses.filter((c) => `${c.title} ${c.folder}`.toLocaleLowerCase().includes(query))) {
    const button = node('button', item.title, 'course-row');
    button.type = 'button';
    if (item.course === course) button.setAttribute('aria-current', 'page');
    button.append(node('small', [item.folder, fmtTs(item.duration), item.partial ? '部分完成' : ''].filter(Boolean).join(' · ')));
    button.addEventListener('click', () => run(async () => { course = item.course; version = ''; await read(); }));
    list.append(button);
  }
}

async function read() {
  const ticket = ++generation;
  clearTimeout(positionTimer);
  imagesObserver?.disconnect();
  status('正在校验课程文件');
  const result = await request('read');
  if (ticket !== generation) return;
  version = result.manifest.version_id;
  doc = result.web ?? fromUpstream(result.document);
  /** @type {HTMLButtonElement} */ (byId('native-export')).disabled = false;
  /** @type {HTMLInputElement} */ (byId('original')).checked = Boolean(result.web && doc?.meta.polished === false);
  versions.replaceChildren(...result.versions.map(/** @param {any} v */ (v) => new Option(`第 ${v.revision} 版 · ${new Date(v.created).toLocaleString()}`, v.id)));
  versions.value = version;
  history.replaceState(null, '', `?${new URLSearchParams({ library, course, version })}`);
  byId('empty').hidden = true;
  byId('article').hidden = false;
  byId('title').textContent = doc?.meta.title ?? '';
  byId('meta').textContent = [doc?.meta.uploader, fmtTs(doc?.meta.duration ?? 0), result.manifest.partial ? '部分完成' : ''].filter(Boolean).join(' · ');
  const source = /** @type {HTMLAnchorElement} */ (byId('source'));
  source.href = videoUrl(doc?.meta.url ?? ''); source.hidden = !videoUrl(doc?.meta.url ?? '');
  byId('summary').replaceChildren();
  if (result.document.summary) {
    const summary = result.document.summary;
    byId('summary').append(node('h2', '概要'), node('p', summary.tldr));
    const points = node('ul');
    for (const point of summary.key_points) points.append(node('li', point));
    byId('summary').append(points);
  }
  renderBody(ticket, result.web ? [] : result.document.summary?.outline ?? []);
  renderCourses();
  status((result.warnings ?? []).join('\n'));
  const key = positionKey();
  const stored = await chrome.storage.local.get(key);
  if (ticket !== generation) return;
  const saved = /** @type {{paragraph?: number}|undefined} */ (stored[key]);
  if (saved) document.querySelector(`[data-paragraph='${Number(saved.paragraph)}']`)?.scrollIntoView();
  else byId('reader').scrollIntoView();
  byId('reader').focus({ preventScroll: true });
}

function positionKey() { return `reading:${library}:${course}:${version}`; }

/** @param {number} ticket @param {{t: number, title: string, detail: string}[]} outline */
function renderBody(ticket, outline) {
  if (!doc) return;
  const body = byId('body'), toc = byId('toc');
  body.replaceChildren(); toc.replaceChildren();
  let paragraph = 0;
  imagesObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      imagesObserver?.unobserve(entry.target);
      const image = /** @type {HTMLImageElement} */ (entry.target);
      run(async () => {
        try {
          const value = await request('image', { image: image.dataset.path });
          if (ticket === generation) image.src = value.data;
        } catch (error) {
          if (ticket !== generation) return;
          const retry = node('button', '重新读取画面', 'c2md-button');
          retry.type = 'button';
          retry.onclick = () => { retry.remove(); imagesObserver?.observe(image); };
          image.parentElement?.append(retry);
          throw error;
        }
      });
    }
  }, { rootMargin: '600px' });
  for (const [i, section] of doc.sections.entries()) {
    const sec = node('section', '', 'reader-section'); sec.id = `section-${i}`;
    const title = section.title || fmtTs(section.t);
    if (section.title) sec.append(node('h2', title));
    if (!outline.length) { const link = node('a', title); link.href = `#${sec.id}`; toc.append(link); }
    let frameIndex = 0;
    const frames = section.frames ?? [];
    const appendFrame = (/** @type {import('../core/format.js').Frame} */ frame) => {
      if (!frame.image) return;
      const figure = node('figure', '', 'reader-frame');
      const image = node('img'); image.alt = `视频 ${fmtTs(frame.t)} 的画面`; image.dataset.path = frame.image;
      figure.append(image, node('figcaption', fmtTs(frame.t))); sec.append(figure);
      imagesObserver?.observe(image);
    };
    for (const segment of section.segments) {
      while (frameIndex < frames.length && frames[frameIndex].t <= segment.start) appendFrame(frames[frameIndex++]);
      const p = node('p', '', 'reader-paragraph'); p.dataset.paragraph = String(paragraph++);
      p.id = `paragraph-${paragraph}`; p.dataset.seconds = String(segment.start);
      p.dataset.state = segment.state ?? '';
      const time = node('a', fmtTs(segment.start), 'timestamp');
      const source = videoUrl(doc.meta.url ?? '');
      if (source) { time.href = seekUrl(source, segment.start); time.target = '_blank'; time.rel = 'noopener'; }
      else time.removeAttribute('href');
      const text = node('span', segment.text, 'paragraph-text');
      text.dataset.polished = segment.text; text.dataset.raw = segment.raw ?? segment.text;
      p.append(time, text); sec.append(p);
    }
    while (frameIndex < frames.length) appendFrame(frames[frameIndex++]);
    body.append(sec);
  }
  for (const item of outline) {
    const paragraphs = [...body.querySelectorAll('.reader-paragraph')];
    const target = paragraphs.find((p) => Number(/** @type {HTMLElement} */ (p).dataset.seconds) >= item.t) ?? paragraphs.at(-1);
    if (target) { const link = node('a', `${fmtTs(item.t)} ${item.title}`); link.href = `#${target.id}`; toc.append(link); }
  }
  display();
}

function display() {
  const original = /** @type {HTMLInputElement} */ (byId('original')).checked;
  byId('article').dataset.images = String(/** @type {HTMLInputElement} */ (byId('images')).checked);
  byId('article').dataset.timestamps = String(/** @type {HTMLInputElement} */ (byId('timestamps')).checked);
  for (const text of document.querySelectorAll('.paragraph-text')) {
    const element = /** @type {HTMLElement} */ (text);
    element.textContent = (original ? element.dataset.raw : element.dataset.polished) ?? '';
    if (element.parentElement) element.parentElement.hidden = !original && element.parentElement.dataset.state === 'skipped';
  }
  find(false);
}

/** @param {boolean} next */
function find(next) {
  const query = /** @type {HTMLInputElement} */ (byId('query')).value.trim().toLocaleLowerCase();
  matches = [];
  for (const element of document.querySelectorAll('.paragraph-text')) {
    const text = /** @type {HTMLElement} */ (element);
    const source = /** @type {HTMLInputElement} */ (byId('original')).checked ? text.dataset.raw ?? '' : text.dataset.polished ?? '';
    text.textContent = source;
    if (text.parentElement?.hidden) continue;
    const at = query ? source.toLocaleLowerCase().indexOf(query) : -1;
    if (at < 0) continue;
    text.replaceChildren(document.createTextNode(source.slice(0, at)), node('mark', source.slice(at, at + query.length)), document.createTextNode(source.slice(at + query.length)));
    matches.push(text);
  }
  matchIndex = next && matches.length ? (matchIndex + 1) % matches.length : -1;
  byId('matches').textContent = query ? `${matchIndex + 1} / ${matches.length} 段` : '';
  if (next) matches[matchIndex]?.scrollIntoView({ block: 'center' });
}

librarySelect.addEventListener('change', () => run(async () => {
  generation++; library = librarySelect.value; course = ''; version = ''; doc = null;
  imagesObserver?.disconnect(); clearTimeout(positionTimer);
  byId('article').hidden = true; byId('empty').hidden = false; byId('toc').replaceChildren();
  history.replaceState(null, '', 'library.html');
  await chrome.storage.local.set({ selectedLibrary: library });
  if (library) await list(); else { courses = []; renderCourses(); }
}));
byId('connect').addEventListener('submit', (event) => { event.preventDefault(); run(async () => {
  const root = /** @type {HTMLInputElement} */ (byId('root')).value.trim();
  await request('connect', { root }); await discover();
}); });
byId('refresh').addEventListener('click', () => run(discover));
byId('helper-retry').addEventListener('click', () => run(async () => { await discover(); await connectEngine(); }));
byId('engine-install').addEventListener('click', () => run(installEngine));
byId('engine-connect').addEventListener('submit', (event) => { event.preventDefault(); run(() => connectEngine(/** @type {HTMLInputElement} */ (byId('engine-path')).value.trim())); });
byId('native-export').addEventListener('click', () => run(async () => {
  const button = /** @type {HTMLButtonElement} */ (byId('native-export'));
  button.disabled = true;
  try {
    if (!engineAvailable) await installEngine();
    button.disabled = true;
    status('正在导出图文文件');
    const result = await request('export', { format: /** @type {HTMLSelectElement} */ (byId('export-format')).value });
    status(`图文文件已保存：\n${result.outputs.join('\n')}`);
  } finally { button.disabled = !doc; }
}));
byId('filter').addEventListener('input', renderCourses);
versions.addEventListener('change', () => run(async () => { version = versions.value; await read(); }));
byId('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
for (const id of ['images', 'timestamps', 'original']) byId(id).addEventListener('change', display);
byId('query').addEventListener('input', () => { matchIndex = -1; find(false); });
byId('find').addEventListener('submit', (event) => { event.preventDefault(); find(true); });
byId('download').addEventListener('click', () => run(async () => {
  if (!doc) return;
  const checked = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (byId(id)).checked;
  // Text Markdown is portable; image files stay in the original version directory.
  const textDoc = { ...doc, sections: doc.sections.map((s) => ({ ...s, segments: s.segments.map((p) => ({ ...p, text: checked('original') ? p.raw ?? p.text : p.text })) })) };
  await send({ type: 'file.save', payload: { filename: fileNameFor(doc.meta.title), text: toMarkdown(textDoc, { timestamps: checked('timestamps') }) } });
}));
window.addEventListener('scroll', () => {
  if (!doc) return;
  clearTimeout(positionTimer);
  const key = positionKey();
  positionTimer = setTimeout(() => {
    const paragraphs = [...document.querySelectorAll('.reader-paragraph')];
    const paragraph = paragraphs.find((p) => p.getBoundingClientRect().bottom > 24);
    if (paragraph) chrome.storage.local.set({ [key]: { paragraph: Number(/** @type {HTMLElement} */ (paragraph).dataset.paragraph) } });
  }, 250);
}, { passive: true });
run(async () => { applyTheme(withDefaults(await send({ type: 'settings.load' }))); await discover(); await connectEngine(); });
