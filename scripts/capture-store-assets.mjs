// Captures the Chrome Web Store screenshots and the README's demo from a real
// headed Chromium with the extension loaded. The screenshots are the window's
// tabs listed over a page, a search with its results, and the Alt view; the
// demo switches to a tab by its title, goes to one by its key in the Alt view
// and closes the other tabs by name. Run it through
// scripts/capture-store-assets.sh, which provides the tools and the Xvfb display.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, launchBrowser, waitFor } from '../test/browser.js';
import { createStage, run, sleep } from './capture-common.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// The store's screenshot size.
const SCREEN = { width: 1280, height: 800 };
const PINNED = ['https://www.openstreetmap.org/#map=13/52.5200/13.4050', 'https://github.com/'];
const PAGE = 'https://doc.rust-lang.org/book/';
const TABS = [
  PAGE,
  'https://developer.mozilla.org/en-US/docs/Web/API/Window',
  'https://docs.python.org/3/tutorial/index.html',
  'https://nodejs.org/docs/latest/api/',
  'https://www.typescriptlang.org/docs/handbook/intro.html',
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://www.w3.org/TR/css/',
  'https://news.ycombinator.com/',
];
const demoPath = join(root, 'docs', 'demo.webp');
const screenshotPath = (n) => join(root, 'store', `screenshot-${n}.png`);

const stage = createStage({ screen: SCREEN, desktopColor: '#c7ccd4' });
const keys = (...args) => run('xdotool', ['key', ...args]);

async function main() {
  const sandbox = await createSandbox();
  let wm;
  let browser;
  try {
    wm = await stage.startWindowManager(sandbox.root);
    run('xdotool', ['mousemove', String(SCREEN.width / 2), String(SCREEN.height - 4)]);
    mkdirSync(join(sandbox.profile, 'Default'), { recursive: true });
    writeFileSync(join(sandbox.profile, 'Default', 'Preferences'), JSON.stringify({
      intl: { accept_languages: 'en-US,en' },
      browser: { has_seen_welcome_page: true },
    }));
    browser = await launchBrowser({ executable: stage.browserWrapper(sandbox.root), sandbox, extensionPath: root });
    await capture(browser, await browser.extensionWorker());
  } finally {
    await browser?.kill();
    wm?.kill();
    await sandbox.remove();
  }
}

async function capture(browser, worker) {
  await waitFor(() => worker.run(async () => (await chrome.storage.local.get('setupPending')).setupPending === false), { timeout: 30_000 });
  await worker.run(async (screen, pinned, tabs) => {
    await chrome.storage.local.set({ setupDismissed: true, historyDismissed: true, pagesDismissed: true });
    const [window] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const old = await chrome.tabs.query({ windowId: window.id });
    for (const url of pinned) await chrome.tabs.create({ windowId: window.id, url, pinned: true, active: false });
    for (const url of tabs) await chrome.tabs.create({ windowId: window.id, url, active: url === tabs[0] });
    await chrome.tabs.remove(old.map((tab) => tab.id));
    await chrome.windows.update(window.id, { left: 0, top: 0, ...screen, focused: true });
  }, SCREEN, PINNED, TABS);
  await waitFor(() => worker.run(async () => (await chrome.tabs.query({}))
    .every((tab) => tab.status === 'complete' && tab.favIconUrl)), { timeout: 90_000, interval: 250 })
    .catch(async () => console.log('some page has no icon', await worker.run(async () => (await chrome.tabs.query({})).map((tab) => [tab.status, tab.url, Boolean(tab.favIconUrl)]))));
  await sleep(1500);
  const overlay = async () => (await browser.targets()).some((info) => info.url.includes('/src/overlay.html'));
  const open = async () => {
    for (let attempt = 1; !(await overlay()); attempt++) {
      keys('ctrl+shift+space');
      await waitFor(overlay, { timeout: 4_000 }).catch((error) => {
        if (attempt === 4) throw error;
      });
    }
    await sleep(1500);
  };
  const close = async () => {
    keys('Escape');
    await waitFor(async () => !(await overlay()));
    await sleep(500);
  };
  await open();
  await stage.screenshot(screenshotPath(1));
  run('xdotool', ['type', '--delay', '60', 'window']);
  await sleep(1200);
  await stage.screenshot(screenshotPath(2));
  keys('ctrl+a', 'BackSpace');
  await close();
  await open();
  keys('Alt_L');
  await sleep(1200);
  await stage.screenshot(screenshotPath(3));
  keys('Alt_L');
  await close();

  const shown = async () => (await worker.run(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].url));
  const arrive = (part) => waitFor(async () => (await shown()).includes(part));
  const typeSlowly = (text) => run('xdotool', ['type', '--delay', '110', text]);
  const recording = `${demoPath}.mp4`;
  mkdirSync(dirname(demoPath), { recursive: true });
  const stop = stage.startRecording(recording);
  await sleep(1000);
  await open();
  typeSlowly('wikipedia');
  await sleep(1100);
  // The web search comes first.
  keys('Down');
  await sleep(600);
  keys('Return');
  await arrive('wikipedia.org');
  await sleep(1500);
  await open();
  keys('Alt_L');
  await sleep(1300);
  keys('5');
  await arrive('docs.python.org');
  await sleep(1500);
  await open();
  typeSlowly('close other');
  await sleep(1100);
  keys('Return');
  await waitFor(() => worker.run(async () => (await chrome.tabs.query({ pinned: false })).length === 1));
  await sleep(1800);
  await stop();
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', recording, '-vf', 'fps=12,scale=960:-1:flags=lanczos,format=yuv420p',
    '-c:v', 'libwebp_anim', '-quality', '60', '-compression_level', '6', '-loop', '0', '-an', demoPath]);
  rmSync(recording);
  console.log(`wrote ${demoPath}`);
}

await main();
