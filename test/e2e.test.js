import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSandbox, findBrowserExecutable, launchBrowser, waitFor } from './browser.js';

const extensionPath = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = findBrowserExecutable();
const skip = executable ? false : 'no browser: set CHROME_PATH or put chromium on PATH';

// Helium keeps the pinned tabs of every window alike itself;
// SYNCED_PINS_HELIUM_PINS=1 runs the suite with that on.
const browserSharesPins = process.env.SYNCED_PINS_HELIUM_PINS === '1';
const unshared = browserSharesPins ? 'the browser adds pinned tabs of its own' : false;

// Starting a browser and its extension worker takes several seconds on a busy
// machine.
const STARTUP_TIMEOUT_MS = 30_000;

// The pages opened in the tests: every path is a page titled after itself.
const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
  // A site behind a login, as a GitHub Enterprise Server: the page sets the
  // session and declares its search, whose description only the session
  // gets, anyone else being answered with the login page.
  if (name === 'gated') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'session=1; Path=/' });
    response.end('<!doctype html><title>gated</title><link rel="search" type="application/opensearchdescription+xml" href="/gated.xml"><h1>gated</h1>');
    return;
  }
  if (name === 'gated.xml') {
    const signedIn = /(^|;\s*)session=1/.test(request.headers.cookie ?? '');
    response.writeHead(200, { 'content-type': signedIn ? 'application/opensearchdescription+xml' : 'text/html; charset=utf-8' });
    response.end(signedIn
      ? `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>gated</ShortName><Url type="text/html" method="get" template="http://${request.headers.host}/find?q={searchTerms}&amp;ref=opensearch"/></OpenSearchDescription>`
      : '<!doctype html><title>Sign in</title><form>login</form>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>${name}</title><h1>${name}</h1>`);
});
let origin;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
// A browser process that outlives its kill, as Vivaldi's can, holds a
// keep-alive connection open, which would keep the server and so the test run
// from ending.
after(() => {
  server.closeAllConnections();
  server.close();
  // Whatever still holds the process open once every test has ended, which
  // scripts/test-e2e.sh then ends with --test-force-exit.
  setTimeout(() => {
    const open = process.getActiveResourcesInfo().filter((name) => name !== 'TTYWrap');
    if (open.length > 0) console.log(`# still open after the tests: ${open.join(', ')}`);
  }, 2000).unref();
});

const pageUrl = (name) => `${origin}/${name}`;

// Runs one browser, on a fresh profile unless a sandbox is handed back in for
// a restart. Developer mode is on so the unpacked extension survives
// chrome.runtime.reload(). On restart the profile reopens its last session
// when restoreSession is set and otherwise follows Chromium's default of
// opening a New Tab page.
async function start({ restoreSession = false, sandbox, extension = extensionPath, keepSetup = false, language } = {}) {
  const fresh = !sandbox;
  if (fresh) {
    sandbox = await createSandbox();
    await mkdir(join(sandbox.profile, 'Default'), { recursive: true });
    await writeFile(join(sandbox.profile, 'Default', 'Preferences'), JSON.stringify({
      extensions: { ui: { developer_mode: true } },
      session: { restore_on_startup: restoreSession ? 1 : 5 },
      // Brave asks before closing a window with several tabs and Edge before
      // closing one with pinned tabs, which holds up chrome.windows.remove
      // until someone answers.
      brave: { enable_window_closing_confirm: false },
      browser: { edge_show_warn_before_closing_window_with_pinned_tabs_prompt: false },
      helium: { browser: { persistent_pins: browserSharesPins } },
    }));
  }
  let browser;
  try {
    browser = await launchBrowser({ executable, sandbox, extensionPath: extension, language });
    const worker = extension === extensionPath
      ? await readyWorker(browser)
      : await browser.extensionWorker();
    if (extension === extensionPath && fresh && !keepSetup) await closeSetup(worker);
    return { sandbox, browser, worker };
  } catch (error) {
    await browser?.kill();
    if (fresh) await sandbox.remove();
    throw error;
  }
}

// Vivaldi takes chrome.tabs.group without error and leaves the tab outside
// any group; elsewhere a tab left ungrouped is a failure of the test.
async function groupingIgnored(worker, tabId) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const ungrouped = await worker.run(async (id) => (await chrome.tabs.get(id)).groupId === -1, tabId);
  if (ungrouped && !/vivaldi/i.test(executable ?? '')) assert.fail('the tab was not grouped');
  return ungrouped;
}

// The page the extension opens once after installation, closed so the
// windows hold only what a test opens.
async function closeSetup(worker) {
  await waitFor(() => worker.run(async () => (await chrome.storage.local.get('setupPending')).setupPending === false),
    { timeout: STARTUP_TIMEOUT_MS });
  await worker.run(async () => {
    const page = chrome.runtime.getURL('src/welcome.html');
    const tabs = (await chrome.tabs.query({})).filter((tab) => (tab.pendingUrl || tab.url).startsWith(page));
    if (tabs.length > 0) await chrome.tabs.remove(tabs.map((tab) => tab.id));
  });
}

// The extension's worker. After a reload the previous worker is gone, so a
// failing context is looked up afresh.
function readyWorker(browser) {
  return waitFor(async () => {
    try {
      const worker = await browser.extensionWorker();
      return await worker.run(() => chrome.runtime.getManifest() !== undefined) && worker;
    } catch {
      return false;
    }
  }, { timeout: STARTUP_TIMEOUT_MS });
}

let current;
afterEach(async () => {
  await current?.browser.kill();
  await current?.sandbox.remove();
  current = undefined;
});

async function open(options) {
  current = await start(options);
  return current;
}

// Quits the browser the way the user does and starts it again on the same
// profile.
async function restart(options) {
  await current.browser.quit();
  current = await start({ ...options, sandbox: current.sandbox });
  return current;
}

// The titles of all pinned tabs.
async function pinnedTitles(worker) {
  return worker.run(async () => (await chrome.tabs.query({ pinned: true })).map((tab) => tab.title).sort());
}

function createWindow(worker, name, options = {}) {
  return worker.run(async (url, options) => (await chrome.windows.create({ url, focused: true, ...options })).id,
    pageUrl(name), options);
}

// Vivaldi ignores the pinned property of chrome.tabs.create, so a tab to be
// pinned is pinned once open, as the user pins one.
function openTab(worker, windowId, name, { pinned = false, ...properties } = {}) {
  return worker.run(async (windowId, url, pinned, properties) => {
    const tab = await chrome.tabs.create({ windowId, url, ...properties });
    if (pinned) await chrome.tabs.update(tab.id, { pinned: true });
    return tab.id;
  }, windowId, pageUrl(name), pinned, properties);
}

async function waitForTitle(worker, tabId, title) {
  await waitFor(() => worker.run(async (id, title) => (await chrome.tabs.get(id)).title === title, tabId, title));
}

// Two normal windows, the first with the pinned tabs 'a' and 'b'.
async function twoWindowsWithPins(worker) {
  const windows = [await createWindow(worker, 'A'), await createWindow(worker, 'B')];
  const a = await openTab(worker, windows[0], 'a', { pinned: true, active: false });
  await waitForTitle(worker, a, 'a');
  const b = await openTab(worker, windows[0], 'b', { pinned: true, active: false });
  await waitForTitle(worker, b, 'b');
  return { windows, a, b };
}

function focus(worker, windowId) {
  return worker.run((id) => chrome.windows.update(id, { focused: true }), windowId);
}

describe('pins of earlier versions and the switch', { skip, concurrency: 1 }, () => {
  test('after the update each pin whose page is open nowhere opens once, pinned, and the list goes', { skip: unshared }, async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const a = await openTab(worker, A, 'a', { pinned: true, active: false });
    await waitForTitle(worker, a, 'a');
    await worker.run((pins) => chrome.storage.local.set({ pins }), [
      { id: '1', url: pageUrl('a') },
      { id: '2', url: pageUrl('moved'), home: { url: pageUrl('b') } },
      { id: '3', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/placeholder.html?pin=9&url=x' },
    ]);
    await worker.run(() => { setTimeout(() => chrome.runtime.reload(), 0); });
    await waitFor(() => worker.run(() => false).catch(() => true));
    const reloaded = await readyWorker(browser);
    await waitFor(() => reloaded.run(async () => (await chrome.storage.local.get('pins')).pins === undefined));
    await waitFor(async () => (await pinnedTitles(reloaded)).join() === 'a,b')
      .catch(async () => assert.deepEqual(await pinnedTitles(reloaded), ['a', 'b']));
    // Nothing is left for a later start to open again.
    await reloaded.run(() => { setTimeout(() => chrome.runtime.reload(), 0); });
    await waitFor(() => reloaded.run(() => false).catch(() => true));
    const again = await readyWorker(browser);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(await pinnedTitles(again), ['a', 'b']);
  });

  test('tabs that stood in for a pin, brought back by the browser, leave its page open once', async () => {
    const { worker } = await open();
    const A = await createWindow(worker, 'A');
    await worker.run(async (windowId, url) => {
      const standIn = `${chrome.runtime.getURL('src/placeholder.html')}?${new URLSearchParams({ pin: '1', url, title: 'a' })}`;
      await Promise.all([1, 2, 3].map(() => chrome.tabs.create({ windowId, url: standIn, active: false })));
    }, A, pageUrl('a'));
    const urls = async () => (await tabsIn(worker, A)).map((tab) => tab.url).sort();
    await waitFor(async () => JSON.stringify(await urls()) === JSON.stringify([pageUrl('A'), pageUrl('a')].sort()))
      .catch(async () => assert.deepEqual(await urls(), [pageUrl('A'), pageUrl('a')].sort()));
  });

  test('pinned tabs are left alone: pinning and a new window change no other tab', { skip: unshared }, async () => {
    const { worker } = await open();
    const A = await createWindow(worker, 'A');
    const a = await openTab(worker, A, 'a', { pinned: true, active: false });
    await waitForTitle(worker, a, 'a');
    const B = await createWindow(worker, 'B');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const own = (tabs) => tabs.filter((tab) => tab.pinned && tab.id !== a).length;
    assert.equal(own(await tabsIn(worker, A)) + own(await tabsIn(worker, B)), 0);
  });

  test('switched off a New Tab page stays the browser\'s own; switched on it becomes the overlay', async () => {
    const { worker } = await open();
    const A = await createWindow(worker, 'A');
    // The switch sits in the button's right-click menu; updating an entry
    // fails where there is none.
    await worker.run(() => chrome.contextMenus.update('on', {}));
    await worker.run(() => chrome.storage.local.set({ off: true }));
    await waitFor(() => worker.run(async () => (await chrome.action.getTitle({})).endsWith(' is off')));
    const newTab = () => worker.run(async (windowId) => (await chrome.tabs.create({ windowId, url: 'chrome://newtab/' })).id, A);
    const urlOf = (id) => worker.run(async (tabId) => { const tab = await chrome.tabs.get(tabId); return tab.pendingUrl || tab.url; }, id);
    const left = await newTab();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.doesNotMatch(await urlOf(left), /overlay\.html/);
    await worker.run(() => chrome.storage.local.set({ off: false }));
    await waitFor(() => worker.run(async () => !(await chrome.action.getTitle({})).endsWith(' is off')));
    await newTab();
    await waitFor(async () => (await tabsIn(worker, A)).some((tab) => tab.url.includes('/src/overlay.html?mode=tab')));
  });
});

// The overlay frame over the page in the window, once it has started.
async function overlayFrame(browser) {
  const target = await waitFor(async () => (await browser.targets()).find(
    (info) => info.type === 'iframe' && info.url.includes('/src/overlay.html'),
  )).catch(async (error) => {
    const targets = (await browser.targets()).filter((info) => info.type === 'page' || info.type === 'iframe')
      .map((info) => `${info.type} ${info.url.slice(0, 90)}`);
    const fallback = await current.worker.run(async () => (await chrome.storage.session.get('overlayFallback')).overlayFallback ?? null);
    throw new Error(`${error.message}\nfallback: ${JSON.stringify(fallback)}\ntargets: ${JSON.stringify(targets)}`);
  });
  const frame = await browser.attach(target.targetId);
  await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, frame.sessionId);
  await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
  return frame;
}

// Presses the extension's shortcut, Ctrl+Shift+Space, on the page.
async function pressShortcut(context) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    current.browser.connection.send('Input.dispatchKeyEvent', {
      type, key: ' ', code: 'Space', modifiers: 2 | 8, windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    }, context.sessionId).catch(() => {});
  }
}

function pressCtrlT(context) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    current.browser.connection.send('Input.dispatchKeyEvent', {
      type, key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84,
    }, context.sessionId).catch(() => {});
  }
}

function overlayOpen(browser) {
  return browser.targets().then((targets) => targets.some((info) => info.url.includes('/src/overlay.html')));
}

// Opens the overlay with the extension's shortcut, pressed on the page. A
// press right after the page loaded is now and then dropped, so a press that
// opens nothing is repeated.
// Vivaldi from its own repository grants the shortcut no access to the page
// on the CI runner, so the overlay opens as a tab of its own there; a test of
// the overlay over a page then has nothing to test.
class NoOverlayInPage extends Error {}

// A shortcut press on the CI runners is now and then dropped several times in
// a row.
const SHORTCUT_TRIES = 5;

function overlayTest(name, fn) {
  test(name, async (context) => {
    try {
      await fn(context);
    } catch (error) {
      if (!(error instanceof NoOverlayInPage)) throw error;
      context.skip(error.message);
    }
  });
}

// Presses the overlay's shortcut over the page and holds the overlay's frame
// at its start, so keys can reach the page while the overlay is in it but not
// yet ready, however fast the machine. Resolves with the frame's session to
// let go of, or null where the shortcut gave no access to the page.
async function shortcutWithFrameHeld(page) {
  let paused;
  const frameStarted = new Promise((resolve) => {
    const stop = current.browser.connection.onEvent((message) => {
      if (message.method !== 'Target.attachedToTarget' || message.sessionId !== page.sessionId) return;
      // The frame's address is not known yet when it attaches; the page has
      // no frame of its own.
      if (message.params.targetInfo.type !== 'iframe') return;
      paused = message.params.sessionId;
      stop();
      resolve();
    });
  });
  await current.browser.connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, page.sessionId);
  pressShortcut(page);
  const started = await Promise.race([frameStarted.then(() => true), new Promise((resolve) => setTimeout(resolve, 8_000, false))]);
  return started ? paused : null;
}

async function pressOverlayShortcut(browser, name, url = pageUrl(name)) {
  // The shortcut acts on the selected tab of the window focused last.
  // A page still loading replaces the document the overlay is drawn into.
  await waitFor(() => current.worker.run(async (url) => (await chrome.tabs.query({ url })).some((tab) => tab.active && tab.status === 'complete'), url));
  const windowId = await current.worker.run(async (url) => (await chrome.tabs.query({ url })).find((tab) => tab.active)?.windowId, url);
  if (windowId !== undefined) {
    await focus(current.worker, windowId);
    await waitFor(() => current.worker.run(async (id) => (await chrome.windows.getLastFocused()).id === id, windowId));
  }
  const page = await browser.page(url);
  // The shortcut grants the extension the selected tab of the browser's
  // active window; without a window manager that need not be the window the
  // key goes to, so the page's window is made the active one.
  await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
  await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page.sessionId);
  for (let attempt = 1; ; attempt++) {
    await pressShortcut(page);
    // Which overlay the press opened: over the page, or, where the shortcut
    // was given no access to it, as a tab.
    let kind;
    try {
      kind = await waitFor(async () => {
        const targets = await browser.targets();
        if (targets.some((info) => info.type === 'iframe' && info.url.includes('/src/overlay.html'))) return 'page';
        if (targets.some((info) => info.url.includes('/src/overlay.html?mode=tab'))) return 'tab';
        return null;
      }, { timeout: 8_000 });
    } catch (error) {
      if (attempt === SHORTCUT_TRIES) throw error;
      await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
      continue;
    }
    if (kind === 'page') return overlayFrame(browser);
    if (kind === 'tab' && /vivaldi/i.test(executable ?? '')) {
      throw new NoOverlayInPage('Vivaldi gave the shortcut no access to the page, so the overlay opened as a tab');
    }
    // Now and then on the CI runners the shortcut grants no access to the
    // page; the fallback goes again and that try counts as lost.
    for (const info of (await browser.targets()).filter((target) => target.url.includes('/src/overlay.html?mode=tab'))) {
      await current.browser.connection.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }
    await waitFor(async () => !(await overlayOpen(browser)));
    if (attempt === SHORTCUT_TRIES) throw new Error(`the shortcut was given no access to the page in ${SHORTCUT_TRIES} tries; the overlay opened as the ${kind}`);
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
  }
}

// Sets the browser's "Allow access to file URLs" for the extension, which
// reloads it, and gives back its new worker.
async function setFileAccess(browser, worker, fileAccess) {
  const tab = await worker.run(async () => (await chrome.tabs.create({ url: 'chrome://extensions' })).id);
  await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', tab));
  const page = await browser.page((url) => /^[a-z]+:\/\/extensions\/?$/.test(url));
  const extensionId = await worker.run(() => chrome.runtime.id);
  await page.run((id, allowed) => new Promise((resolve) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: allowed }, resolve)), extensionId, fileAccess);
  const next = await waitFor(async () => {
    try {
      const candidate = await readyWorker(browser);
      return await candidate.run(() => chrome.extension.isAllowedFileSchemeAccess()) === fileAccess && candidate;
    } catch {
      return false;
    }
  });
  current.worker = next;
  await next.run((id) => chrome.tabs.remove(id), tab);
  return next;
}

// Clicks the toolbar button in the tab's window, the way its click reaches
// the extension: as a closeTabs message, sent from an extension page in a
// window of its own that goes again afterwards.
async function clickButton(browser, worker, tabId) {
  const welcome = await worker.run(async () => {
    const window = await chrome.windows.create({ url: chrome.runtime.getURL('src/welcome.html'), focused: false });
    return { windowId: window.id, tabId: window.tabs[0].id };
  });
  // Vivaldi leaves a page that is attached to while it loads unanswered.
  await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', welcome.tabId));
  const page = await browser.page((url) => url.includes('/src/welcome.html'));
  await page.run((id) => chrome.runtime.sendMessage({ type: 'closeTabs', tabId: id }), tabId);
  await worker.run((id) => chrome.windows.remove(id), welcome.windowId);
}

async function typeInto(frame, text) {
  await current.browser.connection.send('Input.insertText', { text }, frame.sessionId);
}

function overlayResults(frame) {
  return frame.run(() => [...document.querySelectorAll('#results .row')].map((row) => ({
    title: row.querySelector('.title').textContent,
    kind: row.querySelector('.kind').textContent,
    key: row.querySelector('.key')?.textContent,
    selected: row.classList.contains('selected'),
  })));
}

function tabsIn(worker, windowId) {
  return worker.run(async (id) => (await chrome.tabs.query({ windowId: id })).map((tab) => ({
    id: tab.id, title: tab.title, url: tab.pendingUrl || tab.url, pinned: tab.pinned, active: tab.active, groupId: tab.groupId,
  })), windowId);
}

describe('overlay and closing button', { skip, concurrency: 1 }, () => {
  overlayTest('letters typed between the shortcut and the overlay being ready go to its field, not to the page', async (context) => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await waitFor(() => worker.run(async (url) => (await chrome.tabs.query({ url })).some((tab) => tab.active && tab.status === 'complete'), pageUrl('A')));
    await focus(worker, A);
    await waitFor(() => worker.run(async (id) => (await chrome.windows.getLastFocused()).id === id, A));
    const page = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page.sessionId);
    // The page's own listener sits below the window, where a site's would.
    await page.run(() => {
      window.pageKeys = '';
      document.addEventListener('keydown', (event) => { window.pageKeys += event.key; });
    });
    const paused = await shortcutWithFrameHeld(page);
    if (!paused) return context.skip('the shortcut gave no access to the page this time');
    const word = 'youtube';
    for (const letter of word) {
      for (const type of ['keyDown', 'keyUp']) {
        await current.browser.connection.send('Input.dispatchKeyEvent', {
          type, key: letter, code: `Key${letter.toUpperCase()}`, text: type === 'keyDown' ? letter : undefined,
          windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
        }, page.sessionId);
      }
    }
    await current.browser.connection.send('Runtime.runIfWaitingForDebugger', {}, paused);
    const frame = await overlayFrame(browser);
    await waitFor(() => frame.run(() => document.getElementById('query').value.startsWith('youtube')));
    // Vivaldi passes the shortcut's own Space to the page as well; no typed
    // letter may arrive there.
    assert.equal((await page.run(() => window.pageKeys)).replace(/[^a-z]/g, ''), '');
  });

  overlayTest('text pasted between the shortcut and the overlay being ready goes to its field, not to the page', async (context) => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await waitFor(() => worker.run(async (url) => (await chrome.tabs.query({ url })).some((tab) => tab.active && tab.status === 'complete'), pageUrl('A')));
    await focus(worker, A);
    await waitFor(() => worker.run(async (id) => (await chrome.windows.getLastFocused()).id === id, A));
    const page = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page.sessionId);
    await current.browser.connection.send('Browser.grantPermissions', { origin: new URL(pageUrl('A')).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
    await page.run(async () => {
      await navigator.clipboard.writeText('example.org/pasted');
      window.pagePastes = 0;
      document.addEventListener('paste', () => { window.pagePastes++; });
    });
    const paused = await shortcutWithFrameHeld(page);
    if (!paused) return context.skip('the shortcut gave no access to the page this time');
    for (const type of ['rawKeyDown', 'keyUp']) {
      await current.browser.connection.send('Input.dispatchKeyEvent', {
        type, key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
        commands: type === 'rawKeyDown' ? ['paste'] : undefined,
      }, page.sessionId);
    }
    await current.browser.connection.send('Runtime.runIfWaitingForDebugger', {}, paused);
    const frame = await overlayFrame(browser);
    await waitFor(() => frame.run(() => document.getElementById('query').value.startsWith('example.org/pasted')));
    assert.equal(await page.run(() => window.pagePastes), 0);
  });

  overlayTest('the overlay\'s bar shows at once with what is typed, before its frame has loaded, where the overlay then draws it', async (context) => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await waitFor(() => worker.run(async (url) => (await chrome.tabs.query({ url })).some((tab) => tab.active && tab.status === 'complete'), pageUrl('A')));
    await focus(worker, A);
    await waitFor(() => worker.run(async (id) => (await chrome.windows.getLastFocused()).id === id, A));
    const page = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page.sessionId);
    const paused = await shortcutWithFrameHeld(page);
    if (!paused) return context.skip('the shortcut gave no access to the page this time');
    for (const letter of 'gh') {
      for (const type of ['keyDown', 'keyUp']) {
        await current.browser.connection.send('Input.dispatchKeyEvent', {
          type, key: letter, code: `Key${letter.toUpperCase()}`, text: type === 'keyDown' ? letter : undefined,
          windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
        }, page.sessionId);
      }
    }
    // The bar drawn by the page, read through its closed shadow root.
    const shellBar = async () => {
      const { root } = await current.browser.connection.send('DOM.getDocument', { depth: -1, pierce: true }, page.sessionId);
      const find = (node) => {
        if (node.attributes?.includes('class') && node.attributes[node.attributes.indexOf('class') + 1] === 'box') return node;
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      };
      const box = find(root);
      if (!box) return null;
      const { model } = await current.browser.connection.send('DOM.getBoxModel', { backendNodeId: box.backendNodeId }, page.sessionId);
      const text = await current.browser.connection.send('DOM.resolveNode', { backendNodeId: box.backendNodeId }, page.sessionId)
        .then(({ object }) => current.browser.connection.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return this.textContent; }', returnByValue: true }, page.sessionId));
      const [x, y, right] = model.border;
      return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), text: text.result.value };
    };
    const early = await waitFor(async () => {
      const bar = await shellBar();
      return bar?.text === 'gh' ? bar : null;
    });
    assert.equal(await page.run(() => document.getElementById('synced-pins-overlay').dataset.ready), undefined);
    await current.browser.connection.send('Runtime.runIfWaitingForDebugger', {}, paused);
    const frame = await overlayFrame(browser);
    await waitFor(() => page.run(() => document.getElementById('synced-pins-overlay').dataset.ready === '1'));
    await waitFor(() => frame.run(() => document.getElementById('query').value.startsWith('gh')));
    await waitFor(() => frame.run(() => document.getAnimations().length === 0));
    const box = await frame.run(() => {
      const rect = document.getElementById('box').getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
    });
    // The same box, to the pixel the two measurements round to.
    for (const side of ['x', 'y', 'width']) assert.ok(Math.abs(early[side] - box[side]) <= 1, `${side}: ${JSON.stringify({ early, box })}`);
    assert.equal(await shellBar(), null);
  });

  overlayTest('over a page too busy to answer the overlay opens as a tab over its picture, and Escape goes back', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await waitFor(() => worker.run(async (url) => (await chrome.tabs.query({ url })).some((tab) => tab.active && tab.status === 'complete'), pageUrl('A')));
    const [{ id }] = await tabsIn(worker, A);
    await focus(worker, A);
    await waitFor(() => worker.run(async (windowId) => (await chrome.windows.getLastFocused()).id === windowId, A));
    const page = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page.sessionId);
    // The page's main thread is busy for most of a second, as a page with a
    // stuttering video can be.
    await page.run(() => {
      setTimeout(() => {
        const end = Date.now() + 800;
        while (Date.now() < end);
      }, 0);
    });
    pressShortcut(page);
    const overlayTab = () => worker.run(async (windowId) => (await chrome.tabs.query({ windowId }))
      .find((tab) => (tab.pendingUrl || tab.url).includes('/src/overlay.html?mode=tab') && (tab.pendingUrl || tab.url).includes('picture=1'))?.id, A);
    const plainOverlayTab = () => worker.run(async (windowId) => (await chrome.tabs.query({ windowId }))
      .some((tab) => (tab.pendingUrl || tab.url).includes('/src/overlay.html?mode=tab') && !(tab.pendingUrl || tab.url).includes('picture=1')), A);
    const vivaldi = /vivaldi/i.test(executable ?? '');
    const opened = await waitFor(async () => (await overlayTab()) || (vivaldi && await plainOverlayTab())).then(() => true, (error) => {
      if (vivaldi) return false;
      throw error;
    });
    if (!opened || !(await overlayTab())) throw new NoOverlayInPage('Vivaldi gives the extension no access to the page on the CI runner, so the overlay opens as a plain tab or not over the page');
    const overlay = await browser.page((url) => url.includes('/src/overlay.html?mode=tab'));
    await waitFor(() => overlay.run(() => document.body?.classList.contains('picture') === true));
    // The page's own code, run once the page is free, opens nothing more.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await page.run(() => document.getElementById('synced-pins-overlay')), null);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, overlay.sessionId);
    await waitFor(() => overlay.run(() => document.activeElement?.id === 'query'));
    await overlay.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayTab()) && (await tabsIn(worker, A)).find((tab) => tab.active)?.id === id);
  });

  overlayTest('the shortcut opens the overlay over the page without a tab, and Escape closes it', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const before = (await tabsIn(worker, A)).length;
    const frame = await pressOverlayShortcut(browser, 'A');
    assert.equal((await tabsIn(worker, A)).length, before);
    // How long the opening took is kept, step by step.
    let timing;
    await waitFor(async () => {
      [timing] = (await worker.run(() => chrome.storage.local.get('overlayTimings'))).overlayTimings ?? [];
      return timing?.ready !== undefined;
    });
    assert.ok(['pageRan', 'injected', 'frameStarted', 'ready'].every((step) => Number.isFinite(timing[step])), JSON.stringify(timing));
    await frame.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
  });

  overlayTest('an address typed in the overlay opens in a new tab', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const frame = await pressOverlayShortcut(browser, 'A');
    await typeInto(frame, pageUrl('typed').replace('http://', ''));
    await waitFor(async () => (await overlayResults(frame))[0]?.kind === 'Open');
    await frame.press('Enter', { wait: false });
    await waitFor(async () => (await tabsIn(worker, A)).some((tab) => tab.title === 'typed' && tab.active));
    await waitFor(async () => !(await overlayOpen(browser)));
  });

  overlayTest('the overlay offers open tabs and pins, and picking one selects it', async () => {
    const { worker, browser } = await open();
    const { windows: [A, B] } = await twoWindowsWithPins(worker);
    const other = await openTab(worker, A, 'other');
    await waitForTitle(worker, other, 'other');
    await focus(worker, B);
    const frame = await pressOverlayShortcut(browser, 'B');
    await typeInto(frame, 'othe');
    await waitFor(async () => (await overlayResults(frame)).some((row) => row.title === 'other' && row.kind === 'Switch to Tab'));
    const rows = await overlayResults(frame);
    for (let index = 0; index < rows.findIndex((row) => row.title === 'other'); index++) await frame.press('ArrowDown');
    await frame.press('Enter', { wait: false });
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).active, other));
    await waitFor(async () => !(await overlayOpen(browser)));
    // A pinned tab is picked like any other, in whichever window it is, and
    // offered once where every window has a copy of it.
    const copy = await openTab(worker, B, 'a', { pinned: true, active: false });
    await waitForTitle(worker, copy, 'a');
    await focus(worker, B);
    const again = await pressOverlayShortcut(browser, 'B');
    await typeInto(again, 'a');
    const pinRows = async () => (await overlayResults(again)).filter((row) => row.title === 'a' && row.kind === 'Switch to Tab');
    await waitFor(async () => (await pinRows()).length > 0);
    assert.equal((await pinRows()).length, 1);
    const all = await overlayResults(again);
    for (let index = 0; index < all.findIndex((row) => row.title === 'a' && row.kind === 'Switch to Tab'); index++) await again.press('ArrowDown');
    await again.press('Enter', { wait: false });
    await waitFor(async () => (await tabsIn(worker, B)).some((tab) => tab.active && tab.pinned && tab.title === 'a'));
  });

  overlayTest('an action named in the overlay acts on the tab it was opened over', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const [tab] = (await tabsIn(worker, A));
    const frame = await pressOverlayShortcut(browser, 'A');
    await typeInto(frame, 'pin tab');
    await waitFor(async () => (await overlayResults(frame))[0]?.title === 'Pin Tab');
    await frame.press('Enter', { wait: false });
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).pinned, tab.id));
  });

  overlayTest('a browser page named in the overlay shows its address and opens', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const frame = await pressOverlayShortcut(browser, 'A');
    await typeInto(frame, 'downloads');
    await waitFor(async () => (await overlayResults(frame))[0]?.title === 'Downloads');
    const first = await frame.run(() => {
      const row = document.querySelector('#results .row');
      return { kind: row.querySelector('.kind').textContent, site: row.querySelector('.site').textContent };
    });
    assert.ok(['Browser', 'Brave', 'Edge'].includes(first.kind), first.kind);
    assert.match(first.site, /^[a-z]+:\/\/downloads$/);
    // Every page of the list is one the browser has.
    const pages = await frame.run(async () => (await import('./quick-actions.js')).browserPages());
    await frame.press('Enter', { wait: false });
    await waitFor(async () => (await tabsIn(worker, A)).some((tab) => /^[a-z]+:\/\/downloads\/?$/.test(tab.url)));
    const opened = await worker.run(async (addresses, windowId) => {
      const tabs = await Promise.all(addresses.map((url) => chrome.tabs.create({ windowId, url, active: false })));
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return Promise.all(tabs.map(async ({ id }) => {
        const tab = await chrome.tabs.get(id);
        return { url: tab.url || tab.pendingUrl, title: tab.title };
      }));
    }, pages.map((page) => page.address), A);
    const missing = opened.filter(({ url, title }) => !url || /not available|can.t be reached|ERR_/i.test(title ?? ''));
    assert.deepEqual(missing, [], JSON.stringify(opened));
  });

  overlayTest('closing other tabs leaves pins and tab groups, and the button\'s second click gives up the selected tab for a pick in the overlay', async (context) => {
    const { worker, browser } = await open();
    const { windows: [A], a } = await twoWindowsWithPins(worker);
    await focus(worker, A);
    const grouped = await openTab(worker, A, 'grouped');
    await worker.run((id) => chrome.tabs.group({ tabIds: [id] }), grouped);
    if (await groupingIgnored(worker, grouped)) return context.skip('Vivaldi ignores tab groups made by an extension');
    const loose = await openTab(worker, A, 'loose');
    const current = await openTab(worker, A, 'current', { active: true });
    await waitForTitle(worker, current, 'current');
    const badge = () => worker.run((id) => chrome.action.getBadgeText({ tabId: id }), current);
    // A: the window's first tab, loose: one more; the group and pins stay.
    let shown;
    await waitFor(async () => (shown = await badge()) === '2').catch(async () => assert.fail(`badge ${shown}, tabs ${JSON.stringify(await tabsIn(worker, A))}`));
    const frame = await pressOverlayShortcut(browser, 'current');
    await typeInto(frame, 'close other');
    await waitFor(async () => (await overlayResults(frame))[0]?.title === 'Close Other Tabs');
    await frame.press('Enter', { wait: false });
    await waitFor(async () => {
      const titles = (await tabsIn(worker, A)).filter((tab) => !tab.pinned).map((tab) => tab.title);
      return titles.join() === 'grouped,current';
    });
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), loose), false);
    await waitFor(async () => (await badge()) === '1');
    // Named in the overlay once only the selected tab is left, it closes
    // nothing more.
    const again = await pressOverlayShortcut(browser, 'current');
    await typeInto(again, 'close other');
    await waitFor(async () => (await overlayResults(again))[0]?.title === 'Close Other Tabs');
    await again.press('Enter', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), current), true);
    // The button's second click opens the overlay over the selected tab,
    // which goes once a pin is picked there.
    await clickButton(browser, worker, current);
    const second = await overlayFrame(browser);
    assert.match((await browser.targets()).find((info) => info.type === 'iframe' && info.url.includes('/src/overlay.html')).url, /replace=1/);
    await second.press('ArrowDown');
    await second.press('Enter', { wait: false });
    await waitFor(async () => (await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), current)) === false);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).active, a));
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), grouped), true);
  });

  overlayTest('an address picked in the overlay of the button\'s second click loads in the tab it was opened over', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const [tab] = await tabsIn(worker, A);
    // Escape keeps the tab.
    const first = await pressOverlayShortcut(browser, 'A');
    await first.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    await clickButton(browser, worker, tab.id);
    const kept = await overlayFrame(browser);
    await kept.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    assert.equal(await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), tab.id), true);
    await clickButton(browser, worker, tab.id);
    const frame = await overlayFrame(browser);
    await typeInto(frame, pageUrl('there').replace('http://', ''));
    await waitFor(async () => (await overlayResults(frame))[0]?.kind === 'Open');
    await frame.press('Enter', { wait: false });
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).title === 'there', tab.id));
    assert.equal((await tabsIn(worker, A)).length, 1);
  });

  test('over a page the browser keeps to itself the overlay opens as a tab beside it, which Escape closes', async () => {
    const { worker, browser } = await open();
    const B = await createWindow(worker, 'B');
    const [{ id }] = await tabsIn(worker, B);
    await worker.run((tabId) => chrome.tabs.update(tabId, { url: 'chrome://version' }), id);
    // Edge shows chrome://version as edge://version.
    const version = await browser.page((url) => /^[a-z]+:\/\/version/.test(url));
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, version.sessionId);
    const shown = async () => (await browser.targets()).some((info) => info.url.includes('/src/overlay.html?mode=tab'));
    for (let attempt = 1; !(await shown()); attempt++) {
      await pressShortcut(version);
      await waitFor(shown, { timeout: 8_000 }).catch((error) => {
        if (attempt === 3) throw error;
      });
    }
    // Vivaldi leaves a page that is attached to while it loads unanswered.
    await waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0]?.status === 'complete', B));
    const overlay = await browser.page((url) => url.includes('/src/overlay.html?mode=tab'));
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, overlay.sessionId);
    await waitFor(() => overlay.run(() => document.activeElement?.id === 'query'));
    assert.equal(await overlay.run(() => document.getElementById('files').hidden), true);
    await overlay.press('Escape', { wait: false });
    let tabs;
    await waitFor(async () => {
      tabs = await tabsIn(worker, B);
      return tabs.length === 1 && tabs[0].id === id && tabs[0].active;
    }).catch((error) => assert.fail(`${error.message}\nversion tab ${id}, window B: ${JSON.stringify(tabs)}`));
  });

  test('two quick presses over a page the browser keeps to itself open one overlay tab', async () => {
    const { worker, browser } = await open();
    const B = await createWindow(worker, 'B');
    const [{ id }] = await tabsIn(worker, B);
    await worker.run((tabId) => chrome.tabs.update(tabId, { url: 'chrome://version' }), id);
    const version = await browser.page((url) => /^[a-z]+:\/\/version/.test(url));
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, version.sessionId);
    const overlays = async () => (await tabsIn(worker, B)).filter((tab) => tab.url.includes('/src/overlay.html'));
    for (let attempt = 1; (await overlays()).length === 0; attempt++) {
      pressShortcut(version);
      pressShortcut(version);
      await waitFor(async () => (await overlays()).length > 0, { timeout: 8_000 }).catch((error) => {
        if (attempt === 3) throw error;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const tabs = await tabsIn(worker, B);
    assert.equal(tabs.filter((tab) => tab.url.includes('/src/overlay.html')).length, 1, JSON.stringify(tabs));
  });

  overlayTest('a local file takes the browser\'s file access: without it the overlay offers the switch, with it the file opens and the overlay draws over it', async () => {
    let { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const local = (name) => join(current.sandbox.profile, `${name}.html`);
    await writeFile(local('report'), '<title>report</title>');
    await writeFile(local('other'), '<title>other</title>');
    const isOverlayTab = (url) => url.includes('/src/overlay.html?mode=tab');
    // An extension installed from a store starts without it, one loaded from
    // a folder with it.
    worker = await setFileAccess(browser, worker, false);
    const first = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.navigate', { url: `file://${local('report')}` }, first.sessionId);
    await waitFor(() => worker.run(async (windowId) => {
      const [tab] = await chrome.tabs.query({ windowId });
      return tab.status === 'complete' && tab.url.startsWith('file:');
    }, A));
    const file = await browser.page((url) => url.startsWith('file:'));
    await current.browser.connection.send('Page.bringToFront', {}, file.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, file.sessionId);
    await focus(worker, A);
    const tabShown = async () => (await browser.targets()).some((info) => isOverlayTab(info.url));
    for (let attempt = 1; !(await tabShown()); attempt++) {
      await pressShortcut(file);
      await waitFor(tabShown, { timeout: 8_000 }).catch((error) => {
        if (attempt === 3) throw error;
      });
    }
    await waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0]?.status === 'complete', A));
    const overlay = await browser.page(isOverlayTab);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, overlay.sessionId);
    await waitFor(() => overlay.run(() => document.activeElement?.id === 'query'));
    await waitFor(() => overlay.run(() => !document.getElementById('files').hidden));
    await typeInto(overlay, `file://${local('other')}`);
    await waitFor(async () => (await overlayResults(overlay))[0]?.kind === 'Open');
    await overlay.press('Enter', { wait: false });
    // The browser would refuse the file, so Enter leads to the switch.
    const id = await worker.run(() => chrome.runtime.id);
    await waitFor(() => worker.run(async (windowId, extension) => (await chrome.tabs.query({ windowId }))
      .some((tab) => /^[a-z]+:\/\/extensions\/\?id=/.test(tab.pendingUrl || tab.url) && (tab.pendingUrl || tab.url).endsWith(extension)), A, id));

    worker = await setFileAccess(browser, worker, true);
    await current.browser.connection.send('Page.bringToFront', {}, file.sessionId);
    await worker.run(async (windowId) => {
      const [tab] = (await chrome.tabs.query({ windowId })).filter((other) => other.url.startsWith('file:'));
      await chrome.tabs.update(tab.id, { active: true });
    }, A);
    await focus(worker, A);
    const frame = await pressOverlayShortcut(browser, 'report', `file://${local('report')}`);
    await typeInto(frame, `file://${local('other')}`);
    await waitFor(async () => (await overlayResults(frame))[0]?.kind === 'Open');
    assert.equal(await frame.run(() => document.getElementById('files').hidden), true);
    await frame.press('Enter', { wait: false });
    await waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId })).some((tab) => tab.url.endsWith('/other.html') && tab.status === 'complete'), A));
  });

  overlayTest('a path as a file manager gives it reads as a local file and opens', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const path = join(current.sandbox.profile, 'my#report.html');
    await writeFile(path, '<title>report</title>');
    const frame = await pressOverlayShortcut(browser, 'A');
    const type = async (text) => {
      await frame.run(() => { const input = document.getElementById('query'); input.value = ''; input.dispatchEvent(new Event('input')); });
      await typeInto(frame, text);
    };
    const paths = [
      ['C:/Users/me/Documents/a.html', 'file:///C:/Users/me/Documents/a.html'],
      ['C:\\Users\\me\\My Documents\\a.html', 'file:///C:/Users/me/My%20Documents/a.html'],
      ['"C:\\Users\\me\\a.html"', 'file:///C:/Users/me/a.html'],
      ['z:\\Shared\\a.html', 'file:///z:/Shared/a.html'],
      ['D:/a.html', 'file:///D:/a.html'],
      ['\\\\server\\share\\a.html', 'file://server/share/a.html'],
    ];
    for (const [text, address] of paths) {
      await type(text);
      await waitFor(async () => {
        const [first] = await overlayResults(frame);
        return first?.kind === 'Open' && first.title === address;
      });
    }
    await type('/r/rust memes');
    await waitFor(async () => (await overlayResults(frame))[0]?.kind === 'Search');
    await type(path);
    await waitFor(async () => (await overlayResults(frame))[0]?.kind === 'Open');
    await frame.press('Enter', { wait: false });
    await waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId })).some((tab) => tab.url.endsWith('/my%23report.html') && tab.status === 'complete'), A));
  });

  test('the button\'s second click on a page the overlay cannot be drawn over leaves the overlay in its place', async () => {
    const { worker, browser } = await open();
    const { windows: [, B] } = await twoWindowsWithPins(worker);
    await focus(worker, B);
    const own = (await tabsIn(worker, B)).find((tab) => !tab.pinned).id;
    // Without the page granted by a shortcut or click, the overlay cannot be
    // drawn over it and takes the tab's place.
    await clickButton(browser, worker, own);
    await waitFor(async () => {
      const tabs = await tabsIn(worker, B);
      return !tabs.some((tab) => tab.id === own)
        && tabs.some((tab) => tab.active && !tab.pinned && tab.url.includes('/src/overlay.html?mode=tab'));
    });
    // An address picked there opens in that same tab.
    // Vivaldi leaves a page that is attached to while it loads unanswered.
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.query({ windowId: id, active: true }))[0]?.status === 'complete', B));
    const page = await browser.page((url) => url.includes('/src/overlay.html?mode=tab'));
    await waitFor(() => page.run(() => document.activeElement?.id === 'query'));
    await typeInto(page, pageUrl('there').replace('http://', ''));
    await waitFor(async () => (await overlayResults(page))[0]?.kind === 'Open');
    await page.press('Enter', { wait: false });
    await waitFor(async () => {
      const tabs = (await tabsIn(worker, B)).filter((tab) => !tab.pinned);
      return tabs.length === 1 && tabs[0].title === 'there';
    }).catch(async (error) => assert.fail(`${error.message}\n${JSON.stringify(await tabsIn(worker, B))}`));
  });

  overlayTest('the overlay opens a private window', async () => {
    const { worker, browser } = await open();
    await createWindow(worker, 'A');
    const frame = await pressOverlayShortcut(browser, 'A');
    await typeInto(frame, 'private window');
    await waitFor(async () => (await overlayResults(frame))[0]?.title === 'Open Private Window');
    await frame.press('Enter', { wait: false });
    // The extension is kept out of private windows and cannot see them, so
    // the new window is looked for as a page in a browser context of its own.
    const main = (await browser.targets()).find((info) => info.type === 'page' && info.url === pageUrl('A')).browserContextId;
    let privatePage;
    await waitFor(async () => {
      privatePage = (await browser.targets()).find((info) => info.type === 'page' && info.browserContextId !== main);
      return privatePage;
    });
    // Vivaldi keeps the test run alive after its kill while a private window
    // is left open.
    await current.browser.connection.send('Target.closeTarget', { targetId: privatePage.targetId });
  });

  test('a tab opened on the New Tab page becomes the overlay, and Escape goes back to the tab before', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const [before] = await tabsIn(worker, A);
    await worker.run(async (windowId) => chrome.tabs.create({ windowId, url: 'chrome://newtab/' }), A);
    let created;
    await waitFor(async () => {
      created = await worker.run(async (windowId) => (await chrome.tabs.query({ windowId }))
        .find((tab) => (tab.pendingUrl || tab.url).includes('/src/overlay.html?mode=tab&newtab=1') && tab.status === 'complete')?.id, A);
      return created;
    });
    const afterNewTab = await tabsIn(worker, A);
    assert.equal(afterNewTab.length, 2, JSON.stringify(afterNewTab.map((tab) => tab.url)));
    const page = await browser.page((url) => url.includes('/src/overlay.html?mode=tab&newtab=1'));
    await waitFor(() => page.run(() => document.activeElement?.id === 'query'));
    await page.press('Escape', { wait: false });
    await waitFor(async () => (await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), created)) === false);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).active, before.id));
  });

  overlayTest('text selected in the field shows as a selection, and only a filled-in address as grey text', async () => {
    const { browser } = await open();
    const { worker } = current;
    await createWindow(worker, 'A');
    const frame = await pressOverlayShortcut(browser, 'A');
    await typeInto(frame, 'hello world');
    const shown = () => frame.run(() => {
      const query = document.getElementById('query');
      query.select();
      const muted = getComputedStyle(document.body).getPropertyValue('--muted').trim();
      const probe = Object.assign(document.createElement('span'), { style: `color:${muted}` });
      document.body.append(probe);
      const grey = getComputedStyle(probe).color;
      probe.remove();
      return { color: getComputedStyle(query, '::selection').color, grey };
    });
    const { color, grey } = await shown();
    assert.notEqual(color, grey);
  });

  overlayTest('over a page in full screen the first Escape closes the overlay and the page stays in full screen', async () => {
    const { worker, browser } = await open();
    await createWindow(worker, 'A');
    await waitFor(() => worker.run(async (url) => (await chrome.tabs.query({ url })).some((tab) => tab.status === 'complete'), pageUrl('A')));
    const page = await browser.page(pageUrl('A'));
    // Video sites put their player in full screen, not the whole page.
    await page.run(() => {
      const player = document.createElement('div');
      player.id = 'player';
      player.style.background = 'black';
      document.body.append(player);
    });
    await current.browser.connection.send('Runtime.evaluate', { expression: "document.getElementById('player').requestFullscreen()", userGesture: true, awaitPromise: true }, page.sessionId);
    await waitFor(() => page.run(() => document.fullscreenElement?.id === 'player'));
    const frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
    await waitFor(() => page.run(() => document.getElementById('synced-pins-overlay')?.dataset.ready === '1'));
    // The overlay is drawn over the player, not under it.
    assert.equal(await page.run(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#synced-pins-overlay') !== null), true);
    // The key goes in through the page, the way the keyboard sends it. In
    // full screen with the keyboard held Chrome at times never confirms the
    // key event, so the outcome is waited for instead.
    await page.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    // Brave and Vivaldi take Escape to leave full screen whatever the page
    // holds; the overlay goes with it.
    if (/brave|vivaldi/i.test(executable ?? '')) return;
    assert.equal(await page.run(() => document.fullscreenElement !== null), true);
    assert.equal(await page.run(() => document.hasFocus()), true);
    // With the overlay gone Escape is the browser's again, once the keyboard
    // the overlay held is let go as the first Escape's key comes up.
    await waitFor(async () => {
      await page.press('Escape', { wait: false });
      return page.run(() => document.fullscreenElement === null);
    });
  });

  overlayTest('with history allowed, a typed site comes first and visited pages after the tabs', async () => {
    // A copy that asks for history and bookmarks up front, which an unpacked
    // extension is granted without the dialog the overlay's Include opens.
    const copy = await mkdtemp(join(tmpdir(), 'synced-pins-history-'));
    try {
      await cp(extensionPath, copy, { recursive: true, filter: (path) => !/\/(node_modules|dist|\.git)(\/|$)/.test(path) });
      const manifest = JSON.parse(await readFile(join(copy, 'manifest.json'), 'utf8'));
      manifest.permissions.push('history', 'bookmarks');
      delete manifest.optional_permissions;
      await writeFile(join(copy, 'manifest.json'), JSON.stringify(manifest));
      const { worker, browser } = await open({ extension: copy });
      await createWindow(worker, 'A');
      const visited = await worker.run(async (url) => (await chrome.tabs.create({ url, active: false })).id, pageUrl('remembered'));
      await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', visited));
      await worker.run((id) => chrome.tabs.remove(id), visited);
      const frame = await pressOverlayShortcut(browser, 'A');
      assert.equal(await frame.run(() => document.getElementById('history').hidden), true);
      await typeInto(frame, 'remembered');
      await waitFor(async () => (await overlayResults(frame)).some((row) => row.title === 'remembered' && row.kind === 'History'));
      await frame.run(() => { const input = document.getElementById('query'); input.value = ''; input.dispatchEvent(new Event('input')); });
      await typeInto(frame, '127');
      await waitFor(async () => {
        const [first] = await overlayResults(frame);
        return first?.title === '127.0.0.1' && first.kind === 'Site';
      });
      // The rest of the site's address is filled in, selected, after the typed
      // text, so the next key replaces it.
      await waitFor(() => frame.run(() => {
        const input = document.getElementById('query');
        return input.value === '127.0.0.1' && input.selectionStart === 3 && !document.getElementById('hint').hidden;
      }));
      // The hint names the page that opens, the site's front page, never
      // another page of the site visited more.
      assert.equal(await frame.run(() => document.querySelector('#hint span').textContent), '127.0.0.1');
      await frame.press('Backspace');
      assert.deepEqual(await frame.run(() => [document.getElementById('query').value, document.getElementById('hint').hidden]), ['127', true]);
      await frame.press('Escape', { wait: false });
      await waitFor(async () => !(await overlayOpen(browser)));
      // Text that reads as an address of its own still gives way to a visited
      // site it starts, and sign-in steps are not offered.
      await worker.run(async () => {
        await chrome.history.addUrl({ url: 'https://photos.example.com/' });
        await chrome.history.addUrl({ url: 'https://photos.example.com/signin/challenge/pwd' });
      });
      const again = await pressOverlayShortcut(browser, 'A');
      await typeInto(again, 'photos.ex');
      await waitFor(async () => {
        const [first] = await overlayResults(again);
        return first?.title === 'photos.example.com' && first.kind === 'Site';
      });
      await waitFor(() => again.run(() => document.getElementById('query').value === 'photos.example.com'));
      const rows = await overlayResults(again);
      assert.equal(rows[1]?.kind, 'Open', JSON.stringify(rows));
      assert.ok(!rows.some((row) => row.kind === 'History'), JSON.stringify(rows));
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  overlayTest('Tab on a site with a search of its own searches that site', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'synced-pins-history-'));
    try {
      await cp(extensionPath, copy, { recursive: true, filter: (path) => !/\/(node_modules|dist|\.git)(\/|$)/.test(path) });
      const manifest = JSON.parse(await readFile(join(copy, 'manifest.json'), 'utf8'));
      manifest.permissions.push('history', 'bookmarks');
      delete manifest.optional_permissions;
      await writeFile(join(copy, 'manifest.json'), JSON.stringify(manifest));
      const { worker, browser } = await open({ extension: copy });
      const A = await createWindow(worker, 'A');
      await worker.run(() => chrome.history.addUrl({ url: 'https://www.youtube.com/' }));
      const frame = await pressOverlayShortcut(browser, 'A');
      await typeInto(frame, 'youtu');
      // The site row, selected, carries the Tab key once the list of
      // searches is read.
      await waitFor(() => frame.run(() => document.querySelector('#results .row.selected .tabkey') !== null));
      await frame.press('Tab');
      await waitFor(() => frame.run(() => !document.getElementById('chip').hidden));
      assert.deepEqual(await frame.run(() => [document.getElementById('chip').textContent, document.getElementById('query').value]), ['youtube.com', '']);
      await typeInto(frame, 'cats');
      await waitFor(async () => (await overlayResults(frame)).some((row) => row.title === 'cats' && row.kind === 'Search'));
      await frame.press('Enter', { wait: false });
      await waitFor(async () => (await tabsIn(worker, A)).some((tab) => tab.url === 'https://www.youtube.com/results?search_query=cats'));
      // Backspace on an empty field leaves the site.
      const [{ id: first }] = await tabsIn(worker, A);
      await worker.run((id) => chrome.tabs.update(id, { active: true }), first);
      const again = await pressOverlayShortcut(browser, 'A');
      await typeInto(again, 'youtu');
      await waitFor(() => again.run(() => document.querySelector('#results .row.selected .tabkey') !== null));
      await again.press('Tab');
      await waitFor(() => again.run(() => !document.getElementById('chip').hidden));
      await again.press('Backspace');
      await waitFor(() => again.run(() => document.getElementById('chip').hidden));
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  test('a site behind a login has its search learned with the page\'s session', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'synced-pins-learn-'));
    try {
      await cp(extensionPath, copy, { recursive: true, filter: (path) => !/\/(node_modules|dist|\.git)(\/|$)/.test(path) });
      const manifest = JSON.parse(await readFile(join(copy, 'manifest.json'), 'utf8'));
      manifest.host_permissions = ['<all_urls>'];
      delete manifest.optional_host_permissions;
      await writeFile(join(copy, 'manifest.json'), JSON.stringify(manifest));
      const { worker } = await open({ extension: copy });
      await waitFor(() => worker.run(async () => (await chrome.scripting.getRegisteredContentScripts()).length > 0));
      await worker.run((url) => chrome.tabs.create({ url }), pageUrl('gated'));
      let learned;
      await waitFor(async () => {
        learned = await worker.run(async () => (await chrome.storage.local.get('learnedSearch')).learnedSearch?.['127.0.0.1']);
        return learned !== undefined;
      });
      assert.equal(learned, `${origin}/find?q={{{s}}}&ref=opensearch`);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  overlayTest('with nothing typed the overlay lists the window\'s tabs with their keys, and offers history until allowed or dismissed', async () => {
    const { worker, browser } = await open();
    const { windows: [A] } = await twoWindowsWithPins(worker);
    await focus(worker, A);
    const frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(async () => (await overlayResults(frame)).length > 0);
    // The window's tabs in strip order, its pins first, each with its key,
    // and nothing selected.
    const rows = await overlayResults(frame);
    assert.deepEqual(rows.map(({ title, kind, key, selected }) => [title, kind, key, selected]),
      [['a', 'Pinned', '1', false], ['b', 'Pinned', '2', false], ['A', 'Current', '3', false]]);
    assert.equal(await frame.run(() => document.getElementById('history').hidden), false);
    await frame.run(() => document.getElementById('history-dismiss').click());
    await frame.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    const again = await pressOverlayShortcut(browser, 'A');
    await waitFor(async () => (await overlayResults(again)).length > 0);
    assert.equal(await again.run(() => document.getElementById('history').hidden), true);
  });

  overlayTest('a New Tab page opened by the same key press as the overlay closes again', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await pressOverlayShortcut(browser, 'A');
    // What a browser that keeps Ctrl+T for itself, like Vivaldi, does on it.
    const created = await worker.run(async (windowId) => (await chrome.tabs.create({ windowId, url: 'chrome://newtab/', active: false })).id, A);
    await waitFor(async () => (await worker.run((id) => chrome.tabs.get(id).then(() => true, () => false), created)) === false);
    assert.equal((await tabsIn(worker, A)).length, 1);
  });

  test('the browser\'s own new tab becomes the overlay with the keyboard in its bar', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await focus(worker, A);
    const page = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
    const overlayTab = () => worker.run(async (windowId) => (await chrome.tabs.query({ windowId }))
      .find((tab) => (tab.pendingUrl || tab.url).includes('/src/overlay.html?mode=tab&newtab=1') && tab.status === 'complete')?.id, A);
    // Ctrl+T, still the browser's own here.
    for (let attempt = 1; !(await overlayTab()); attempt++) {
      pressCtrlT(page);
      await waitFor(overlayTab, { timeout: 5_000 }).catch((error) => {
        if (attempt === SHORTCUT_TRIES) throw error;
      });
    }
    const overlay = await browser.page((url) => url.includes('/src/overlay.html?mode=tab&newtab=1'));
    await waitFor(() => overlay.run(() => document.hasFocus() && document.activeElement?.id === 'query'))
      .catch(async (error) => assert.fail(`${error.message}\n${JSON.stringify(await tabsIn(worker, A))}`));
    assert.equal((await tabsIn(worker, A)).length, 2);
  });

  // Alt on its own, sent to the overlay's frame, where the keyboard is.
  async function tapAlt(frame) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await current.browser.connection.send('Input.dispatchKeyEvent', {
        type, key: 'Alt', code: 'AltLeft', modifiers: type === 'keyUp' ? 0 : 1, windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18,
      }, frame.sessionId);
    }
  }

  async function pressKey(frame, key, { alt = false } = {}) {
    const code = /^[0-9]$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`;
    for (const type of ['rawKeyDown', 'keyUp']) {
      await current.browser.connection.send('Input.dispatchKeyEvent', {
        type, key, code, modifiers: alt ? 1 : 0, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      }, frame.sessionId);
    }
  }

  const activeIn = async (worker, windowId) => (await tabsIn(worker, windowId)).find((tab) => tab.active)?.id;

  overlayTest('holding Alt shows the tabs\' keys at once; let go alone they stay, and after another key typing comes back', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    await openTab(worker, A, 'b', { active: false });
    const frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
    const alt = (type) => current.browser.connection.send('Input.dispatchKeyEvent', {
      type, key: 'Alt', code: 'AltLeft', modifiers: type === 'keyUp' ? 0 : 1, windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18,
    }, frame.sessionId);
    const numbers = () => frame.run(() => document.getElementById('box').classList.contains('numbers'));
    // Down: the keys show before Alt is let go.
    await alt('rawKeyDown');
    await waitFor(numbers);
    await alt('keyUp');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await numbers(), true);
    // A tap turns typing back on.
    await alt('rawKeyDown');
    await alt('keyUp');
    await waitFor(async () => !(await numbers()));
    // Held with Shift, which picks no tab, typing comes back when let go.
    await alt('rawKeyDown');
    await waitFor(numbers);
    await current.browser.connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 9, windowsVirtualKeyCode: 16 }, frame.sessionId);
    await current.browser.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 1, windowsVirtualKeyCode: 16 }, frame.sessionId);
    await alt('keyUp');
    await waitFor(async () => !(await numbers()));
  });

  overlayTest('a tap on Alt turns typing off, and a tab\'s key alone picks it; Alt again turns typing back on with the text kept, and Escape closes', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const names = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    for (const name of names) await openTab(worker, A, name, { active: false });
    const order = (await tabsIn(worker, A));
    const frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
    await frame.run(() => {
      const query = document.getElementById('query');
      query.value = 'kept';
      query.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'kept' }));
    });
    await tapAlt(frame);
    await waitFor(() => frame.run(() => document.getElementById('box').classList.contains('numbers')));
    // The field is gone and every tab is listed with its key.
    assert.equal(await frame.run(() => getComputedStyle(document.getElementById('bar')).display), 'none');
    const rows = await overlayResults(frame);
    assert.deepEqual(rows.map((row) => row.key), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c']);
    // A letter types nothing; Alt again brings the text back.
    await pressKey(frame, 'z');
    await tapAlt(frame);
    await waitFor(() => frame.run(() => !document.getElementById('box').classList.contains('numbers')));
    assert.equal(await frame.run(() => document.getElementById('query').value), 'kept');
    assert.equal(await overlayOpen(browser), true);
    // Again, and the 11th tab's key picks it.
    await tapAlt(frame);
    await waitFor(() => frame.run(() => document.getElementById('box').classList.contains('numbers')));
    await pressKey(frame, 'b');
    await waitFor(async () => (await activeIn(worker, A)) === order[10].id);
    await waitFor(async () => !(await overlayOpen(browser)));
    // In number mode one Escape closes the overlay.
    // The tab picked is the 11th in the strip, whichever page that is where
    // the browser opened a page of its own beside the window's first.
    const again = await pressOverlayShortcut(browser, order[10].title, order[10].url);
    await waitFor(() => again.run(() => document.activeElement?.id === 'query'));
    await tapAlt(again);
    await waitFor(() => again.run(() => document.getElementById('box').classList.contains('numbers')));
    await again.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
  });

  overlayTest('Alt with a tab\'s key picks it while typing', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    for (const name of ['b', 'c']) await openTab(worker, A, name, { active: false });
    const order = await tabsIn(worker, A);
    const frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
    await frame.run(() => {
      const query = document.getElementById('query');
      query.value = 'something';
      query.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'something' }));
    });
    await pressKey(frame, '3', { alt: true });
    await waitFor(async () => (await activeIn(worker, A)) === order[2].id);
  });

  overlayTest('number mode shows a few tabs as one list and forty in four columns', async () => {
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    for (let n = 0; n < 4; n++) await openTab(worker, A, `t${n}`, { active: false });
    let frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
    await tapAlt(frame);
    await waitFor(() => frame.run(() => document.getElementById('box').dataset.columns === '1' && document.getElementById('box').classList.contains('numbers')));
    await frame.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    for (let n = 4; n < 39; n++) await openTab(worker, A, `t${n}`, { active: false });
    frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
    await tapAlt(frame);
    await waitFor(() => frame.run(() => document.getElementById('box').dataset.columns === '4'));
    await waitFor(() => frame.run(() => document.getAnimations().length === 0));
    const layout = await frame.run(() => {
      const rows = [...document.querySelectorAll('#results .row')];
      const columns = new Set(rows.map((row) => Math.round(row.getBoundingClientRect().left)));
      const results = document.getElementById('results');
      return { rows: rows.length, columns: columns.size, keys: rows.map((row) => row.querySelector('.key').textContent).slice(-5), scrolls: results.scrollHeight > results.clientHeight + 1 };
    });
    assert.deepEqual(layout, { rows: 40, columns: 4, keys: ['01', '02', '03', '04', '05'], scrolls: false });
    // A two key label: 0, then the key.
    const order = await tabsIn(worker, A);
    await pressKey(frame, '0');
    await pressKey(frame, '2');
    await waitFor(async () => (await activeIn(worker, A)) === order[36].id);
  });

  overlayTest('with pages allowed, a New Tab page goes and the overlay opens over the page before it', async () => {
    // A copy that asks for every page up front, which an unpacked extension
    // is granted without the dialog the overlay's Allow opens.
    const copy = await mkdtemp(join(tmpdir(), 'synced-pins-pages-'));
    try {
      await cp(extensionPath, copy, { recursive: true, filter: (path) => !/\/(node_modules|dist|\.git)(\/|$)/.test(path) });
      const manifest = JSON.parse(await readFile(join(copy, 'manifest.json'), 'utf8'));
      manifest.host_permissions = ['<all_urls>'];
      delete manifest.optional_host_permissions;
      await writeFile(join(copy, 'manifest.json'), JSON.stringify(manifest));
      const { worker, browser } = await open({ extension: copy });
      const A = await createWindow(worker, 'A');
      const [before] = await tabsIn(worker, A);
      await focus(worker, A);
      // A page still loading replaces the document the overlay is drawn into.
      await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', before.id));
      await worker.run(async (windowId) => chrome.tabs.create({ windowId, url: 'chrome://newtab/' }), A);
      await waitFor(async () => (await browser.targets()).some((info) => info.url.includes('/src/overlay.html')));
      if (/vivaldi/i.test(executable ?? '') && !(await browser.targets()).some((info) => info.type === 'iframe' && info.url.includes('/src/overlay.html'))) {
        throw new NoOverlayInPage('Vivaldi gives the extension no access to the page on the CI runner, so the overlay opened as a tab');
      }
      const frame = await overlayFrame(browser).catch((error) => {
        if (/vivaldi/i.test(executable ?? '')) throw new NoOverlayInPage(`Vivaldi on the CI runner gives the overlay over the page no focus: ${error.message}`);
        throw error;
      });
      await waitFor(() => frame.run(() => document.activeElement?.id === 'query'));
      const tabs = await tabsIn(worker, A);
      assert.deepEqual(tabs.map((tab) => [tab.id, tab.active]), [[before.id, true]]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  test('whether the browser\'s shortcuts page records Ctrl+T for the overlay', async () => {
    const { worker, browser } = await open();
    const tabId = await worker.run(async () => (await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })).id);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', tabId));
    const page = await browser.page((url) => /^[a-z]+:\/\/extensions\/shortcuts/.test(url));
    await current.browser.connection.send('Page.bringToFront', {}, page.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page.sessionId);
    const id = await worker.run(() => chrome.runtime.id);
    // The page is built of nested shadow roots; the overlay's row is found by
    // the command's description and its edit button clicked.
    const clicked = await page.run((extensionId) => {
      const all = (root) => [root, ...[...root.querySelectorAll('*')].flatMap((element) => (element.shadowRoot ? all(element.shadowRoot) : []))];
      const roots = all(document);
      const inputs = roots.flatMap((root) => [...root.querySelectorAll('cr-shortcut-input, extensions-shortcut-input')]);
      const input = inputs.find((candidate) => (candidate.item?.id ?? candidate.extension ?? '') === extensionId && (candidate.commandName ?? candidate.command?.name) === 'open-overlay')
        ?? inputs.find((candidate) => candidate.closest?.('.command-entry')?.textContent?.includes('Open a new tab'));
      // Edge's page is plain inputs named after the command.
      const plain = document.querySelector('input[aria-label^="Shortcut Open a new tab"]');
      if (!input && plain) {
        plain.click();
        plain.focus();
        return 'clicked';
      }
      if (!input) return `no input among ${inputs.length}`;
      const edit = input.shadowRoot?.querySelector('#edit, cr-icon-button');
      if (!edit) return 'no edit button';
      edit.click();
      return 'clicked';
    }, id);
    let recorded = 'not tried';
    if (clicked === 'clicked') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        for (const type of ['rawKeyDown', 'keyUp']) {
          await current.browser.connection.send('Input.dispatchKeyEvent', { type, key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84 }, page.sessionId);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        recorded = await worker.run(async () => (await chrome.commands.getAll()).find((command) => command.name === 'open-overlay')?.shortcut);
      } catch (error) {
        recorded = `the page took no keys: ${error.message}`;
      }
    }
    console.log(`SHORTCUTS PAGE ${executable}: ${clicked}, overlay shortcut now ${JSON.stringify(recorded)}`);
  });

  test('installing opens the page that puts the overlay on Ctrl+T, once', async () => {
    const { browser, worker, sandbox } = await open({ keepSetup: true });
    // Vivaldi leaves a page that is attached to while it loads unanswered.
    await waitFor(() => worker.run(async () => (await chrome.tabs.query({})).some((tab) => tab.url.includes('/src/welcome.html') && tab.status === 'complete')));
    const page = await browser.page((url) => url.includes('/src/welcome.html'));
    await waitFor(async () => (await page.run(() => document.getElementById('shortcut').textContent)) === 'Ctrl + Shift + Space');
    const { worker: again } = await restart({ sandbox });
    await waitFor(() => again.run(async () => (await chrome.windows.getAll()).length > 0));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const pages = await again.run(async () => (await chrome.tabs.query({})).filter((tab) => (tab.pendingUrl || tab.url).includes('/src/welcome.html')).length);
    assert.ok(pages <= 1, `${pages} setup pages after a restart`);
  });

  overlayTest('once put on Ctrl+T, Ctrl+T opens the overlay and no tab', async (context) => {
    // Vivaldi on the CI runner gives the shortcut no access to the page, so
    // the overlay opens as a tab there, which is a tab more.
    if (/vivaldi/i.test(executable ?? '')) return context.skip('Vivaldi gives the shortcut no access to the page on the CI runner');
    const { worker, browser } = await open();
    const A = await createWindow(worker, 'A');
    const extensions = await worker.run(async () => (await chrome.tabs.create({ url: 'chrome://extensions' })).id);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', extensions));
    const page = await browser.page((url) => /^[a-z]+:\/\/extensions/.test(url));
    const id = await worker.run(() => chrome.runtime.id);
    await page.run((extensionId) => new Promise((resolve) => chrome.developerPrivate.updateExtensionCommand(
      { extensionId, commandName: 'open-overlay', keybinding: 'Ctrl+T' }, resolve)), id);
    await worker.run((tabId) => chrome.tabs.remove(tabId), extensions);
    await waitFor(async () => (await worker.run(async () => (await chrome.commands.getAll()).find((c) => c.name === 'open-overlay').shortcut)) === 'Ctrl+T');
    const before = (await tabsIn(worker, A)).length;
    await focus(worker, A);
    const target = await browser.page(pageUrl('A'));
    await current.browser.connection.send('Page.bringToFront', {}, target.sessionId);
    await current.browser.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, target.sessionId);
    for (let attempt = 1; !(await overlayOpen(browser)); attempt++) {
      pressCtrlT(target);
      await waitFor(() => overlayOpen(browser), { timeout: 8_000 }).catch((error) => {
        if (attempt === 3) throw error;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const after = await tabsIn(worker, A);
    assert.equal(after.length, before, JSON.stringify(after.map((tab) => tab.url)));
  });

  test('the welcome page asks for pages, history and bookmarks in one dialog, leads to the file switch and marks what is set, with only the next step as the primary one', async () => {
    let { worker, browser } = await open();
    worker = await setFileAccess(browser, worker, false);
    await worker.run(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') }));
    await waitFor(() => worker.run(async () => (await chrome.tabs.query({})).some((tab) => tab.url.endsWith('/src/welcome.html') && tab.status === 'complete')));
    let welcome = await browser.page((url) => url.endsWith('/src/welcome.html'));
    const state = (page) => page.run(() => Object.fromEntries(['full-allow', 'ctrl-t', 'files-allow'].map((id) => {
      const button = document.getElementById(id);
      return [id, button.hidden ? 'set' : button.classList.contains('primary') ? 'primary' : 'offered'];
    })));
    await waitFor(async () => (await state(welcome))['full-allow'] === 'primary');
    assert.deepEqual(await state(welcome), { 'full-allow': 'primary', 'ctrl-t': 'offered', 'files-allow': 'offered' });
    assert.equal(await welcome.run(() => document.getElementById('files-done').hidden), true);
    // The browser's own dialog cannot be answered from a test, so what is
    // asked of it is read instead.
    const asked = await welcome.run(() => new Promise((resolve) => {
      chrome.permissions.request = async (wanted) => {
        resolve(wanted);
        return false;
      };
      document.getElementById('full-allow').click();
    }));
    assert.deepEqual(asked, { permissions: ['history', 'bookmarks'], origins: ['<all_urls>'] });
    const id = await worker.run(() => chrome.runtime.id);
    await welcome.run(() => document.getElementById('files-allow').click());
    await waitFor(() => worker.run(async (extension) => (await chrome.tabs.query({}))
      .some((tab) => /^[a-z]+:\/\/extensions\/\?id=/.test(tab.pendingUrl || tab.url) && (tab.pendingUrl || tab.url).endsWith(extension)), id));
    worker = await setFileAccess(browser, worker, true);
    // The switch reloads the extension, which closes the page; it comes back
    // in place of the tab holding the switch.
    await waitFor(() => worker.run(async () => (await chrome.tabs.query({})).some((tab) => tab.url.endsWith('/src/welcome.html') && tab.status === 'complete')));
    welcome = await browser.page((url) => url.endsWith('/src/welcome.html'));
    await waitFor(async () => (await state(welcome))['files-allow'] === 'set');
    assert.equal(await welcome.run(() => document.getElementById('files-done').hidden), false);
    await waitFor(() => worker.run(async () => !(await chrome.tabs.query({})).some((tab) => /:\/\/extensions\/\?id=/.test(tab.url))));
  });

  overlayTest('a browser in German, where Ctrl+T reads Strg+T, offers no setup once the overlay is on it', async (context) => {
    // Vivaldi on the CI runner reads Strg+T too, but the overlay tab this test
    // opens never answers there.
    if (/vivaldi/i.test(executable ?? '')) return context.skip('the overlay tab the test opens never answers in Vivaldi on the CI runner');
    const { worker, browser } = await open({ language: 'de' });
    const extensions = await worker.run(async () => (await chrome.tabs.create({ url: 'chrome://extensions' })).id);
    await waitFor(() => worker.run(async (id) => (await chrome.tabs.get(id)).status === 'complete', extensions));
    const page = await browser.page((url) => /^[a-z]+:\/\/extensions/.test(url));
    const id = await worker.run(() => chrome.runtime.id);
    await page.run((extensionId) => new Promise((resolve) => chrome.developerPrivate.updateExtensionCommand(
      { extensionId, commandName: 'open-overlay', keybinding: 'Ctrl+T' }, resolve)), id);
    await worker.run((tabId) => chrome.tabs.remove(tabId), extensions);
    const shortcut = await waitFor(async () => {
      const text = await worker.run(async () => (await chrome.commands.getAll()).find((c) => c.name === 'open-overlay').shortcut);
      return /T$/.test(text) && text;
    });
    console.log(`# Ctrl+T reads ${shortcut}`);
    assert.notEqual(shortcut, 'Ctrl+T', 'the browser did not take the German interface');
    await worker.run(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/overlay.html?mode=tab') }));
    // A page can be found before its document runs, so it is asked until it
    // answers.
    const loaded = (page) => waitFor(() => page.run(() => document.readyState === 'complete').catch(() => false));
    const overlay = await browser.page((url) => url.includes('/src/overlay.html?mode=tab'));
    await loaded(overlay);
    // The overlay decides on the row from these two reads; the same reads
    // asked after them answer after them, so the row is settled then.
    const setupHidden = await overlay.run(async () => {
      await Promise.all([chrome.commands.getAll(), chrome.storage.local.get('setupDismissed')]);
      await new Promise((resolve) => setTimeout(resolve));
      return document.getElementById('setup').hidden;
    });
    assert.equal(setupHidden, true);
    await worker.run(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') }));
    const welcome = await browser.page((url) => url.endsWith('/src/welcome.html'));
    await loaded(welcome);
    await waitFor(() => welcome.run(() => !document.getElementById('done').hidden));
    assert.equal(await welcome.run(() => document.getElementById('ctrl-t').hidden), true);
  });

  overlayTest('the overlay offers to go on Ctrl+T until dismissed, and its Set up opens the shortcuts page with the guide beside it', async () => {
    const { worker, browser } = await open();
    await createWindow(worker, 'A');
    const frame = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => frame.run(() => !document.getElementById('setup').hidden));
    await frame.run(() => document.getElementById('setup-dismiss').click());
    await frame.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    const again = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => again.run(() => document.getElementById('query') === document.activeElement));
    assert.equal(await again.run(() => document.getElementById('setup').hidden), true);
    await again.press('Escape', { wait: false });
    await waitFor(async () => !(await overlayOpen(browser)));
    await worker.run(() => chrome.storage.local.remove('setupDismissed'));
    const third = await pressOverlayShortcut(browser, 'A');
    await waitFor(() => third.run(() => !document.getElementById('setup').hidden));
    await third.run(() => document.getElementById('setup-open').click());
    // The browser's shortcuts page opens in a window of its own, with the
    // guide beside it.
    let windows;
    await waitFor(async () => {
      windows = await worker.run(async () => (await chrome.windows.getAll({ populate: true })).map((window) => ({ id: window.id, type: window.type, urls: window.tabs.map((tab) => tab.pendingUrl || tab.url) })));
      return windows.some((window) => window.urls.some((url) => /^[a-z]+:\/\/extensions\/shortcuts/.test(url)))
        && windows.some((window) => window.urls.some((url) => url.includes('/src/welcome.html?guide')));
    });
    const shortcutsWindow = windows.find((window) => window.urls.some((url) => /extensions\/shortcuts/.test(url))).id;
    await waitFor(() => worker.run(async () => (await chrome.tabs.query({})).some((tab) => tab.url.includes('/src/welcome.html?guide') && tab.status === 'complete')));
    const guide = await browser.page((url) => url.includes('/src/welcome.html?guide'));
    assert.deepEqual(await guide.run(() => ['page-steps', 'console-steps', 'worked'].map((id) => document.getElementById(id).hidden)), [false, true, true]);
    // The browser that refuses Ctrl+T there gets the console steps, and its
    // window the extensions page.
    await guide.run(() => document.getElementById('refuses').click());
    await waitFor(() => guide.run(() => !document.getElementById('console-steps').hidden));
    await waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId })).some((tab) => /^[a-z]+:\/\/extensions\/?$/.test(tab.pendingUrl || tab.url)), shortcutsWindow));
    // Once Ctrl+T is set, the guide says so and the other window goes.
    await waitFor(() => worker.run(async (windowId) => (await chrome.tabs.query({ windowId }))[0]?.status === 'complete', shortcutsWindow));
    const extensions = await browser.page((url) => /^[a-z]+:\/\/extensions\/?$/.test(url));
    const id = await worker.run(() => chrome.runtime.id);
    await extensions.run((extensionId) => new Promise((resolve) => chrome.developerPrivate.updateExtensionCommand(
      { extensionId, commandName: 'open-overlay', keybinding: 'Ctrl+T' }, resolve)), id);
    await waitFor(() => guide.run(() => !document.getElementById('worked').hidden));
    await waitFor(async () => !(await worker.run(async (windowId) => chrome.windows.get(windowId).then(() => true, () => false), shortcutsWindow)));
    await worker.run(async () => {
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('src/welcome.html') + '*' });
      await chrome.tabs.remove(tabs.map((tab) => tab.id));
    });
  });
});
