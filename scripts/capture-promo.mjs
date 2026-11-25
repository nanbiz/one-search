// Records the store's promo video, dist/promo.mp4, from a real headed
// Chromium with the extension loaded, drawn at twice the size: one feature per
// scene, named in a caption band from store/promo-captions.json, with every
// key press shown as it happens. Run it through
// sh scripts/capture-store-assets.sh promo.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, launchBrowser, waitFor } from '../test/browser.js';
import { createStage, run, sleep } from './capture-common.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Screen pixels are twice the DIPs Chromium places windows in.
const SCREEN = { width: 1920, height: 1080 };
const SCALE = 2;
const BAND = 62;
const BACKGROUND = '#1b1f27';
const WINDOW = { left: 0, top: BAND, width: SCREEN.width / SCALE, height: SCREEN.height / SCALE - BAND };
const TABS = [
  'https://doc.rust-lang.org/book/',
  'https://developer.mozilla.org/en-US/docs/Web/API/Window',
  'https://docs.python.org/3/tutorial/index.html',
  'https://nodejs.org/docs/latest/api/',
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://www.w3.org/TR/css/',
];
const VISITED = 'https://developer.mozilla.org/en-US/';

const captions = JSON.parse(readFileSync(join(root, 'store', 'promo-captions.json'), 'utf8'));
const promoPath = join(root, 'dist', 'promo.mp4');
const stage = createStage({ screen: SCREEN, scale: SCALE, desktopColor: BACKGROUND });

// What is laid over the recording and when, in seconds from its start.
const timeline = [];
let recordingStart = 0;
const now = () => (Date.now() - recordingStart) / 1000;

function showCaption(id) {
  const open = timeline.findLast((entry) => entry.kind === 'caption' && entry.end === undefined);
  if (open) open.end = now();
  timeline.push({ kind: 'caption', id, start: now() });
}

async function press(keys, label) {
  timeline.push({ kind: 'key', label, start: now(), end: now() + 1 });
  await sleep(200);
  run('xdotool', ['key', keys]);
}

const type = (text) => run('xdotool', ['type', '--delay', '95', text]);

async function main() {
  const sandbox = await createSandbox();
  let wm;
  let browser;
  try {
    // A copy that asks for history up front, which an unpacked extension is
    // granted without the dialog the overlay's Include opens.
    const copy = join(sandbox.root, 'extension');
    for (const part of ['src', 'icons', 'manifest.json']) cpSync(join(root, part), join(copy, part), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
    manifest.permissions.push(...manifest.optional_permissions);
    delete manifest.optional_permissions;
    writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));

    wm = await stage.startWindowManager(sandbox.root);
    run('xdotool', ['mousemove', String(SCREEN.width / 2), String(SCREEN.height - 2)]);
    mkdirSync(join(sandbox.profile, 'Default'), { recursive: true });
    writeFileSync(join(sandbox.profile, 'Default', 'Preferences'), JSON.stringify({
      intl: { accept_languages: 'en-US,en' },
      browser: { has_seen_welcome_page: true },
      extensions: { ui: { developer_mode: true } },
    }));
    browser = await launchBrowser({ executable: stage.browserWrapper(sandbox.root), sandbox, extensionPath: copy });
    const worker = await browser.extensionWorker();
    await setUp(browser, worker);
    const raw = join(sandbox.root, 'promo.mkv');
    const stopRecording = stage.startRecording(raw);
    await sleep(300);
    recordingStart = Date.now();
    try {
      await record(browser, worker);
    } finally {
      await stopRecording();
    }
    render(raw, sandbox.root);
  } finally {
    await browser?.kill();
    wm?.kill();
    await sandbox.remove();
  }
}

async function setUp(browser, worker) {
  await waitFor(() => worker.run(async () => (await chrome.storage.local.get('setupPending')).setupPending === false), { timeout: 30_000 });
  // Ctrl+T, the way the browser's shortcuts page sets it.
  const id = await worker.run(() => chrome.runtime.id);
  await worker.run(() => chrome.tabs.create({ url: 'chrome://extensions' }));
  const extensions = await browser.page((url) => /^chrome:\/\/extensions\/?$/.test(url));
  await waitFor(() => extensions.run(() => Boolean(chrome.developerPrivate)));
  await extensions.run((extensionId) => new Promise((resolve) => chrome.developerPrivate.updateExtensionCommand(
    { extensionId, commandName: 'open-overlay', keybinding: 'Ctrl+T' }, resolve)), id);
  await worker.run(async (bounds, tabs, visited) => {
    await chrome.storage.local.set({ setupDismissed: true, historyDismissed: true, pagesDismissed: true, filesDismissed: true });
    const [window] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const old = await chrome.tabs.query({});
    for (const url of tabs) await chrome.tabs.create({ windowId: window.id, url, active: url === tabs[0] });
    await chrome.tabs.remove(old.map((tab) => tab.id));
    await chrome.windows.update(window.id, { ...bounds, focused: true });
    for (let visit = 0; visit < 3; visit++) await chrome.history.addUrl({ url: visited });
  }, WINDOW, TABS, VISITED);
  await waitFor(() => worker.run(async () => (await chrome.tabs.query({})).every((tab) => tab.status === 'complete' && tab.favIconUrl)), { timeout: 90_000, interval: 250 });
  await sleep(1500);
}

async function record(browser, worker) {
  const overlay = async () => (await browser.targets()).some((info) => info.url.includes('/src/overlay.html'));
  const shown = async () => worker.run(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return `${tab.status} ${tab.url}`;
  });
  const arrive = (part) => waitFor(async () => /^complete /.test(await shown()) && (await shown()).includes(part), { timeout: 30_000 });
  const open = async () => {
    await press('ctrl+t', 'Ctrl + T');
    await waitFor(overlay);
    await sleep(1300);
  };

  showCaption('intro');
  await sleep(2600);
  showCaption('open');
  await open();
  await sleep(1500);

  showCaption('tabs');
  type('wikipedia');
  await sleep(900);
  await press('Down', '↓');
  await sleep(700);
  await press('Return', 'Enter');
  await arrive('wikipedia.org');
  await sleep(1300);

  showCaption('site');
  await open();
  type('dev');
  await sleep(1300);
  await press('Tab', 'Tab');
  await sleep(1000);
  type('flexbox');
  await sleep(900);
  await press('Return', 'Enter');
  await arrive('flexbox');
  await sleep(1800);

  showCaption('alt');
  await open();
  await press('Alt_L', 'Alt');
  await sleep(1800);
  await press('3', '3');
  await arrive('docs.python.org');
  await sleep(1300);

  showCaption('actions');
  await open();
  type('close other');
  await sleep(1100);
  await press('Return', 'Enter');
  await waitFor(() => worker.run(async () => (await chrome.tabs.query({})).length === 1));
  await sleep(1800);

  showCaption('outro');
  await sleep(3200);
  timeline.findLast((entry) => entry.kind === 'caption').end = now();
}

// Lays the captions and keys over the recording and encodes it the way
// YouTube takes it: H.264 in 4:2:0.
function render(raw, workDir) {
  const inputs = [];
  const filters = [];
  let last = '0:v';
  let n = 0;
  const add = (image, x, y, start, end) => {
    n += 1;
    inputs.push('-loop', '1', '-framerate', '30', '-i', image);
    const fade = Math.min(0.2, (end - start) / 3);
    filters.push(`[${n}:v]format=rgba,fade=in:st=${start}:d=${fade}:alpha=1,fade=out:st=${end - fade}:d=${fade}:alpha=1[o${n}]`);
    filters.push(`[${last}][o${n}]overlay=x=${x}:y=${y}:shortest=1:enable='between(t,${start},${end})'[v${n}]`);
    last = `v${n}`;
  };
  const images = drawOverlays(workDir);
  for (const entry of timeline) {
    if (entry.kind === 'caption') add(images.captions[entry.id], 0, 0, entry.start, entry.id === 'outro' ? entry.end + 1 : entry.end);
    else add(images.keys[entry.label], '(main_w-overlay_w)/2', SCREEN.height - 170, entry.start, entry.end);
  }
  mkdirSync(dirname(promoPath), { recursive: true });
  run('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', raw, ...inputs,
    '-filter_complex', `${filters.join(';')};[${last}]fps=30,format=yuv420p[out]`, '-map', '[out]',
    '-t', String(timeline.findLast((entry) => entry.kind === 'caption').end),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-movflags', '+faststart', promoPath,
  ]);
  console.log(`wrote ${promoPath}`);
}

// Each overlay as a transparent picture, with Chromium's own text rendering.
function drawOverlays(workDir) {
  const dir = join(workDir, 'overlays');
  mkdirSync(dir, { recursive: true });
  const chromium = run('sh', ['-c', 'command -v chromium']).trim();
  let count = 0;
  const draw = (width, height, body, style) => {
    const name = join(dir, `overlay-${count++}`);
    writeFileSync(`${name}.html`, `<!doctype html><meta charset="utf-8"><style>
      html, body { margin: 0; background: transparent; font-family: 'Inter', 'Noto Sans', 'DejaVu Sans', sans-serif; }
      ${style}</style>${body}`);
    run(chromium, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${width},${height}`, '--default-background-color=00000000', `--screenshot=${name}.png`, `file://${name}.html`]);
    return `${name}.png`;
  };
  const icon = `file://${join(root, 'icons', 'icon-128.png')}`;
  const captionImages = {};
  for (const [id, { title, subtitle }] of Object.entries(captions)) {
    captionImages[id] = id === 'outro'
      ? draw(SCREEN.width, SCREEN.height, `<div class="card"><img src="${icon}"><h1>${title}</h1><p>${subtitle}</p></div>`, `
        .card { width: 100vw; height: 100vh; background: ${BACKGROUND}; color: #fff; display: flex;
          flex-direction: column; align-items: center; justify-content: center; }
        img { width: 160px; } h1 { font-size: 84px; margin: 32px 0 12px; } p { font-size: 38px; color: #b8c0cc; margin: 0; }`)
      : draw(SCREEN.width, BAND * SCALE, `<div class="band"><img src="${icon}"><h1>${title}</h1><p>${subtitle}</p></div>`, `
        .band { height: ${BAND * SCALE}px; background: ${BACKGROUND}; color: #fff; display: flex; align-items: center;
          gap: 28px; padding: 0 44px; box-sizing: border-box; }
        img { width: 76px; } h1 { font-size: 44px; margin: 0; white-space: nowrap; } p { font-size: 32px; margin: 4px 0 0; color: #b8c0cc; }`);
  }
  const keys = {};
  for (const label of new Set(timeline.filter((entry) => entry.kind === 'key').map((entry) => entry.label))) {
    keys[label] = draw(420, 120, `<div class="key">${label}</div>`, `
      body { display: flex; align-items: center; justify-content: center; height: 120px; }
      .key { font-size: 50px; font-weight: 600; color: #fff; background: rgba(20, 24, 32, 0.9);
        border: 3px solid #f5c542; border-radius: 22px; padding: 10px 34px; }`);
  }
  return { captions: captionImages, keys };
}

await main();
