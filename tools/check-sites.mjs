// Real-site smoke test: loads the real extension into a fresh Chrome profile and generates
// notes on live YouTube / Bilibili pages. The upstream interfaces (YouTube caption tokens,
// Bilibili subtitle endpoints) are the most likely things to break, and no mock can tell.
//
//   npm run check:sites                 run every case
//   npm run check:sites -- youtube      only cases whose name contains "youtube"
//
// Needs Chrome and network access; the "no captions" cases also need the local helper
// (npm run local:install). Not suitable for CI: sites rate-limit and challenge automation.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

/** Each case states what a healthy run looks like. */
const CASES = [
  { name: 'youtube manual captions', url: 'https://www.youtube.com/watch?v=8jPQjjsBbIc', expect: { source: 'subtitle', minEvents: 100 } },
  { name: 'youtube captions after ads', url: 'https://www.youtube.com/watch?v=arj7oStGLkU', expect: { source: 'subtitle', minEvents: 100 } },
  { name: 'youtube no captions -> local transcription', url: 'https://www.youtube.com/watch?v=xE9AZGfLrUw', expect: { source: 'asr', minEvents: 5, warning: '已自动改用本地模型转录' } },
  { name: 'bilibili logged out -> local transcription', url: 'https://www.bilibili.com/video/BV1Mhan6sErs', expect: { source: 'asr', minEvents: 5, warning: '已自动改用本地模型转录' } },
];

if (!CHROME) {
  console.error('Chrome not found.');
  process.exit(1);
}
const filter = process.argv[2]?.toLowerCase();
const cases = CASES.filter((c) => !filter || c.name.includes(filter));
const profile = mkdtempSync(join(tmpdir(), 'c2md-sites-'));
// Sites serve empty captions to browsers flagged as automated, so drop those flags.
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: false, pipe: true, enableExtensions: true, userDataDir: profile,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', '--disable-blink-features=AutomationControlled'],
});

let failures = 0;
try {
  const id = await browser.installExtension(ROOT);
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${id}/src/ui/options.html`);
  for (const test of cases) {
    const page = await browser.newPage();
    const started = Date.now();
    let verdict;
    try {
      await page.goto(test.url, { waitUntil: 'domcontentloaded' });
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const send = (type) => ext.evaluate(async (url, type) => {
        const [tab] = await chrome.tabs.query({ url: `${url}*` });
        return (await chrome.tabs.sendMessage(tab.id, { type }))?.value;
      }, test.url, type);
      await send('c2md.run');
      let state;
      for (let i = 0; i < 600; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        state = await send('c2md.status');
        if (state && state.status !== 'running') break;
      }
      verdict = judge(test.expect, state);
    } catch (error) {
      verdict = `error: ${error?.message ?? error}`;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    if (verdict === 'ok') console.log(`ok   ${test.name} (${seconds}s)`);
    else {
      failures++;
      console.log(`FAIL ${test.name} (${seconds}s): ${verdict}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);

function judge(expect, state) {
  if (!state) return 'no status from the content script';
  if (state.status !== 'ready') return `status ${state.status}: ${state.error?.body ?? state.stageLabel ?? ''}`;
  const events = state.stats?.eventCount ?? 0;
  if (state.stats?.source !== expect.source) return `source ${state.stats?.source}, expected ${expect.source}`;
  if (events < expect.minEvents) return `only ${events} events`;
  if (expect.warning && !(state.warnings ?? []).some((w) => w.includes(expect.warning))) return 'fallback notice missing';
  return 'ok';
}
