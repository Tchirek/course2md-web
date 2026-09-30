// WAR probe test: can a page detect the extension, and does the extension still work?
import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), 'war-test-'));
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER ?? 'C:\Program Files\Google\Chrome\Application\chrome.exe', headless: false, pipe: true, enableExtensions: true, userDataDir: profile,
  ignoreDefaultArgs: ['--enable-automation'], args: ['--no-first-run', '--window-size=1200,800'],
});
try {
  const id = await browser.installExtension(ROOT);
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto('https://www.youtube.com/watch?v=0jljZRnHwOI', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 6000));
  const probe = await page.evaluate(async (id) => {
    try { const r = await fetch(`chrome-extension://${id}/src/core/time.js`); return `fetched ${r.status}`; } catch (e) { return `blocked: ${e.message}`; }
  }, id);
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${id}/src/ui/options.html`);
  await new Promise((r) => setTimeout(r, 1500));
  const send = (type) => ext.evaluate(async (type) => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    return chrome.tabs.sendMessage(tab.id, { type });
  }, type);
  const ping = await send('c2md.ping').catch((e) => 'ping failed: ' + e.message);
  const shown = await send('c2md.showPanel').catch(() => null);
  const run = await send('c2md.run').catch((e) => e.message);
  await new Promise((r) => setTimeout(r, 8000));
  await new Promise((r) => setTimeout(r, 1500));
  const styled = await page.evaluate(() => {
    const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot && el.shadowRoot.querySelector('link[rel=stylesheet]'));
    if (!host) return 'no open shadow host with stylesheet links';
    const links = [...host.shadowRoot.querySelectorAll('link[rel=stylesheet]')];
    return links.map((l) => `${l.href.replace(/^chrome-extension:\/\/([^/]+)/, (m, h) => `ext://${h === location.hostname ? '?' : h.length}`)} sheet=${Boolean(l.sheet)}`).join(' | ');
  });
  const getURL = await ext.evaluate(() => chrome.runtime.getURL('src/core/time.js'));
  console.log(JSON.stringify({ id, getURLFromExtensionPage: getURL, probe, ping: ping?.value ?? ping, run: run?.value ?? run, shown: shown?.ok, styled, errors: errors.filter((e) => /c2md|course2md|chrome-extension|启动/i.test(e)) }, null, 1));
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
