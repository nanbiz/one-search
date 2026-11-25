// The overlay that opens instead of a new tab, and the toolbar button that
// closes the window's other tabs, both run from the extension's service
// worker.

const overlayPath = 'src/overlay.html';
// chrome.tabGroups.TAB_GROUP_ID_NONE, without the tabGroups permission that
// API needs.
const NO_TAB_GROUP = -1;

function inGroup(tab) {
  return tab.groupId !== undefined && tab.groupId !== NO_TAB_GROUP;
}

function overlayUrl(mode, tab) {
  return chrome.runtime.getURL(`${overlayPath}?${new URLSearchParams({ mode, tab: tab.id, window: tab.windowId })}`);
}

// Windows the overlay is being opened in as a tab, and the overlay tabs just
// opened: a tab that has only just been created can show no address yet, so
// a second press arriving then would otherwise open a second overlay over it.
const openingIn = new Set();
const justOpened = new Set();

function isOverlayTab(tab) {
  return justOpened.has(tab.id) || (tab.pendingUrl || tab.url || '').startsWith(chrome.runtime.getURL(overlayPath));
}

// Opens the overlay as a tab with what open() does first, once per window
// at a time, and remembers the tab as the overlay until its address shows.
// Resolves with the tab, or nothing when an overlay is being opened there
// already.
async function openOverlayTab(windowId, open) {
  if (openingIn.has(windowId)) return undefined;
  openingIn.add(windowId);
  try {
    const created = await open();
    if (created) {
      justOpened.add(created.id);
      setTimeout(() => justOpened.delete(created.id), 5_000);
    }
    return created;
  } finally {
    openingIn.delete(windowId);
  }
}

// Opens the overlay over the page in the tab, centred over the page dimmed and
// blurred as Zen does, or closes it where it is open already. Runs in the
// page, so it is self-contained.
function toggleInPage(path, query, openOnly = false, deadline = 0) {
  const id = 'synced-pins-overlay';
  const open = document.getElementById(id);
  // A page that got to this after the worker stopped waiting for it has had
  // the overlay opened as a tab instead.
  if (!open && deadline && Date.now() > deadline) return 'late';
  if (open) {
    if (openOnly) return 'open';
    // The dialog's close event runs the cleanup its opening set up; an
    // overlay left without one is only removed.
    open.dispatchEvent(new Event('close'));
    if (open.isConnected) {
      navigator.keyboard?.unlock();
      open.remove();
    }
    return 'closed';
  }
  // The overlay is a modal dialog, which the browser draws and lets the
  // pointer reach above everything on the page, a player in full screen
  // included, with the page dimmed and blurred under it as its backdrop.
  const dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;'
    + 'border:0;margin:0;padding:0;background:transparent;color-scheme:light dark';
  dialog.tabIndex = -1;
  dialog.className = 'shown';
  const backdrop = new CSSStyleSheet();
  backdrop.replaceSync(`#${id}:not([open]){display:none!important}#${id}::backdrop{background:transparent}#${id}.shown::backdrop{background:rgb(0 0 0 / 0.45);backdrop-filter:blur(3px)}`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, backdrop];
  const frame = document.createElement('iframe');
  frame.src = `${chrome.runtime.getURL(path)}?${query}`;
  frame.allow = 'clipboard-write';
  frame.style.cssText = 'all:initial;position:absolute;inset:0;display:block;width:100%;height:100%;border:0;margin:0;padding:0;color-scheme:light dark;opacity:0';
  // The overlay's bar is drawn at once in the page, with what is typed in
  // it, so the overlay appears with the key press however long its own frame
  // takes to load on a busy page; the frame takes its place once it has drawn
  // the same bar. It sits in a closed shadow root, out of the page's reach
  // and styles, and matches overlay.css's box and bar.
  const shell = document.createElement('div');
  shell.style.cssText = 'all:initial;position:absolute;inset:0';
  const shellRoot = shell.attachShadow({ mode: 'closed' });
  shellRoot.innerHTML = '<style>'
    + '.box{position:fixed;left:50%;transform:translateX(-50%);top:max(24px,calc(50vh - 180px));width:min(66.6vw,750px);'
    + 'background:#fafafa;color:#27272a;border:1px solid #e4e4e7;border-radius:15px;box-shadow:0 16px 60px rgb(0 0 0 / 0.28);'
    + 'font:15px system-ui,sans-serif;overflow:hidden}'
    + '.bar{display:flex;align-items:center;gap:12px;padding:0 18px}'
    + 'svg{width:18px;height:18px;flex:none}'
    + '.text{flex:1;min-width:0;padding:16px 0;font-size:1.15em;white-space:pre;overflow:hidden}'
    + '.text:empty::before{content:"Search or enter address";color:#71717a}'
    + '@media (prefers-color-scheme:dark){.box{background:#1f1f23;color:#e4e4e7;border-color:#34343a}.text:empty::before{color:#8b8b93}}'
    + '</style><div class="box"><div class="bar">'
    + '<svg viewBox="0 0 16 16" fill="none" stroke="#8b8b93" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6"/></svg>'
    + '<span class="text"></span></div></div>';
  const shellText = shellRoot.querySelector('.text');
  let ready = false;
  const show = (shown) => {
    dialog.style.opacity = shown ? '1' : '0';
    dialog.classList.toggle('shown', shown);
  };
  const focusedBefore = document.activeElement;
  // Keys typed and text pasted before the overlay has the keyboard are kept
  // from the page and handed to the overlay once it is ready, so a fast word
  // or a paste right after the shortcut arrives whole.
  let held = '';
  const heldKeys = new Set();
  const hold = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key.length === 1) held += event.key;
    else if (event.key === 'Backspace') held = held.slice(0, -1);
    else return;
    shellText.textContent = held;
    heldKeys.add(event.code);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const holdUp = (event) => {
    if (!heldKeys.delete(event.code)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const holdPaste = (event) => {
    held += event.clipboardData?.getData('text/plain') ?? '';
    shellText.textContent = held;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const release = () => {
    window.removeEventListener('keydown', hold, true);
    window.removeEventListener('keyup', holdUp, true);
    window.removeEventListener('paste', holdPaste, true);
  };
  window.addEventListener('keydown', hold, true);
  window.addEventListener('keyup', holdUp, true);
  window.addEventListener('paste', holdPaste, true);
  // Over a page in full screen the browser takes Escape to leave it before
  // the page sees the key, so the overlay holds Escape while it is open: the
  // first press closes the overlay, and holding Escape still leaves full
  // screen. The overlay shows once the key is held, so an Escape pressed the
  // moment it appears reaches it.
  // A browser that never settles the request leaves the overlay to show after
  // a moment all the same.
  const escapeHeld = document.fullscreenElement && navigator.keyboard
    ? Promise.race([
      navigator.keyboard.lock(['Escape']).then(() => {
        if (!frame.isConnected) navigator.keyboard.unlock();
      }, () => {}),
      new Promise((resolve) => setTimeout(resolve, 200)),
    ])
    : Promise.resolve();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // Escape is held until a press that closed the overlay is let go, so its
    // release does not reach the browser, which would leave full screen.
    const letGo = () => {
      window.removeEventListener('keyup', onKeyUp, true);
      navigator.keyboard?.unlock();
    };
    const onKeyUp = (event) => {
      if (event.key === 'Escape') letGo();
    };
    if (document.fullscreenElement) {
      window.addEventListener('keyup', onKeyUp, true);
      setTimeout(letGo, 1000);
    } else {
      letGo();
    }
    release();
    window.removeEventListener('message', onMessage);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    // The keyboard comes back to the page before the frame that has it goes,
    // so the release of the key that closed the overlay reaches the page.
    dialog.focus({ preventScroll: true });
    if (dialog.open) dialog.close();
    dialog.remove();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== backdrop);
    if (focusedBefore instanceof HTMLElement) focusedBefore.focus({ preventScroll: true });
  };
  // The frame shows once the overlay in it has drawn its bar.
  function onMessage(event) {
    if (event.source !== frame.contentWindow) return;
    if (event.data === 'synced-pins:ready') {
      escapeHeld.then(() => {
        if (!dialog.isConnected) return;
        ready = true;
        dialog.dataset.ready = '1';
        frame.style.opacity = '1';
        shell.remove();
        show(true);
        frame.focus();
        release();
        if (held) frame.contentWindow.postMessage({ syncedPinsTyped: held }, '*');
      });
    }
    if (event.data === 'synced-pins:hide') {
      show(false);
      requestAnimationFrame(() => requestAnimationFrame(() => frame.contentWindow?.postMessage('synced-pins:hidden', '*')));
    }
    if (event.data === 'synced-pins:close') close();
  }
  window.addEventListener('message', onMessage);
  // An overlay that never gets ready leaves no invisible frame over the page.
  setTimeout(() => {
    if (dialog.isConnected && !ready) close();
  }, 3000);
  frame.addEventListener('load', () => frame.focus());
  // Escape over the page before the frame has the keyboard closes the dialog
  // the browser's way; the overlay goes with it.
  dialog.addEventListener('close', close);
  // A browser that takes Escape to leave full screen whatever the page holds
  // closes the overlay with it on that press.
  const onFullscreenChange = () => {
    if (!document.fullscreenElement) close();
  };
  if (document.fullscreenElement) document.addEventListener('fullscreenchange', onFullscreenChange);
  document.documentElement.append(dialog);
  // The dialog opens empty, so it takes the keyboard itself rather than the
  // frame, which the browser would focus while it still loads; keys typed
  // until the frame takes the keyboard reach this page's listeners above.
  dialog.showModal();
  dialog.append(shell, frame);
  return { opened: Date.now(), readyState: document.readyState };
}

// When the overlay's shortcut last arrived, and how soon after it a New Tab
// page counts as opened by the same key press.
let overlayCommandAt = 0;
const SAME_KEY_MS = 500;

// The browsers' New Tab pages, which the overlay replaces wherever a tab
// opens on one: the tab strip's button, the menu, a new window.
const NEW_TAB_PAGE = /^[a-z]+:\/\/(newtab|new-tab-page|startpage|vivaldi-webui\/startpage)([/?#]|$)/;

// Turns a tab that opened on a New Tab page into the overlay as a tab of its
// own; back is the tab that was selected before it, which Escape returns to.
// A pinned one is left alone.
const replacing = new Set();
// Drawing on any page, which the user can allow from the overlay.
const PAGES = { origins: ['<all_urls>'] };

export async function replaceNewTab(tab, url, back, { found = false } = {}) {
  // The browser reports a new tab more than once (created, then its address),
  // and each report would open an overlay of its own.
  if (tab.pinned || replacing.has(tab.id) || !NEW_TAB_PAGE.test(url ?? '')) return;
  replacing.add(tab.id);
  setTimeout(() => replacing.delete(tab.id), 5_000);
  // A browser that keeps Ctrl+T for itself, such as Vivaldi, opens its new
  // tab on the same key that opened the overlay; that tab is not wanted.
  if (Date.now() - overlayCommandAt < SAME_KEY_MS) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  // Where the user lets the extension draw on pages, the New Tab page goes
  // and the overlay opens over the page they were on; elsewhere, and over
  // pages no extension may draw on, it opens as a tab.
  if (!found && back !== undefined && await chrome.permissions.contains(PAGES).catch(() => false)) {
    try {
      const page = await chrome.tabs.get(back);
      if (page.windowId === tab.windowId) {
        const frameQuery = new URLSearchParams({ mode: 'frame', tab: page.id, window: page.windowId }).toString();
        await chrome.scripting.executeScript({ target: { tabId: page.id }, func: toggleInPage, args: [overlayPath, frameQuery, true], injectImmediately: true });
        await chrome.tabs.update(page.id, { active: true });
        await removeNewTab(tab);
        return;
      }
    } catch {
      // A page the overlay cannot be drawn over.
    }
  }
  const query = new URLSearchParams({ mode: 'tab', newtab: '1' });
  if (back !== undefined) query.set('back', back);
  // The browser keeps the keyboard in its address bar on a New Tab page, also
  // once the tab loads another page, so the overlay opens as a tab of its own
  // in the same place, which takes the keyboard, and the New Tab page goes.
  // Edge reports a tab from the tab strip's button as not yet selected, so
  // only the New Tab pages found open at start keep their own state.
  const active = found ? tab.active : true;
  let overlay;
  try {
    overlay = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index, active, url: chrome.runtime.getURL(`${overlayPath}?${query}`) });
  } catch {
    return;
  }
  await removeNewTab(tab);
  // Closing the New Tab page lets Edge select the page before it instead.
  if (active) await chrome.tabs.update(overlay.id, { active: true }).catch(() => {});
}

// Edge refuses to close its New Tab page ("Cannot remove NTP tab"), but lets
// a tab go once it shows another page, so the tab is made blank first there;
// a tab still being added to the strip is tried again for a moment.
async function removeNewTab(tab) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await chrome.tabs.remove(tab.id);
      return;
    } catch (error) {
      const now = await chrome.tabs.get(tab.id).catch(() => null);
      if (!now) return;
      if (/NTP/.test(error?.message ?? '')) await chrome.tabs.update(tab.id, { url: 'about:blank' }).catch(() => {});
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// The overlay opens in the page where the browser lets an extension draw
// into it, and otherwise, as on the browser's own pages or local files
// without the browser's file access, as a tab of its
// own beside the page, the way a New Tab page opens.
// The last overlays opened over a page, with how long each step took, kept
// in local storage so a slow opening on a user's machine can be read back:
// the key's arrival, the page running the code that adds the overlay and
// draws its bar at once (it waits for the page's own work), the overlay's
// frame starting, its data read, and its own bar ready.
const TIMINGS = 20;
const opening = new Map();
// When this worker started: a key arriving just after it had the browser
// wake the worker first, which the timings tell apart.
const workerStarted = Date.now();

async function noteTiming(timing) {
  const { overlayTimings = [] } = await chrome.storage.local.get('overlayTimings');
  await chrome.storage.local.set({ overlayTimings: [...overlayTimings, timing].slice(-TIMINGS) });
}

export function overlayReady(tabId, frameStarted, ready, loaded) {
  const timing = opening.get(tabId);
  if (!timing) return;
  opening.delete(tabId);
  noteTiming({
    ...timing,
    frameStarted: Math.round(frameStarted - timing.key),
    ...(loaded ? { loaded: loaded - timing.key } : {}),
    ready: ready - timing.key,
  });
}

// How long the page has to start drawing the overlay before it opens as a
// tab instead.
const PAGE_ANSWER_MS = 150;

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// The overlay as a tab of its own beside the page, showing a picture of the
// page dimmed and blurred behind it, as the overlay over the page looks.
function openOverPicture(tab) {
  return openOverlayTab(tab.windowId, async () => {
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 }).catch(() => null);
    if (image) await chrome.storage.session.set({ overlayPicture: { tabId: tab.id, image } }).catch(() => {});
    const query = new URLSearchParams({ mode: 'tab', closes: '1', back: tab.id, picture: '1' });
    return chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true, url: chrome.runtime.getURL(`${overlayPath}?${query}`) }).catch(() => null);
  }).then((created) => created?.id);
}

// Closes the overlay over a page the way its own close does. Runs in the
// page.
function closeInPage() {
  document.getElementById('synced-pins-overlay')?.dispatchEvent(new Event('close'));
}

export async function toggleOverlay(tab) {
  overlayCommandAt = Date.now();
  // A New Tab page being turned into the overlay gets it that way; no
  // extension may draw on it, so a second overlay would open beside that one.
  if (!tab || isOverlayTab(tab) || replacing.has(tab.id) || openingIn.has(tab.windowId)) return;
  try {
    const query = new URLSearchParams({ mode: 'frame', tab: tab.id, window: tab.windowId }).toString();
    const key = overlayCommandAt;
    // A page busy with its own work, a video stuttering say, runs the code
    // that draws the overlay only once it gets to it; past a moment the
    // overlay opens as a tab over a picture of the page instead. In full
    // screen it waits, as a tab would end the full screen.
    const window = await chrome.windows.get(tab.windowId).catch(() => null);
    const deadline = window?.state === 'fullscreen' ? 0 : Date.now() + PAGE_ANSWER_MS;
    const injection = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: toggleInPage, args: [overlayPath, query, false, deadline], injectImmediately: true });
    const answer = await (deadline
      ? Promise.race([injection, new Promise((resolve) => setTimeout(resolve, PAGE_ANSWER_MS, 'late'))])
      : injection);
    const [{ result } = {}] = answer === 'late' ? [{ result: 'late' }] : answer;
    if (result === 'late') {
      noteTiming({ at: new Date(key).toISOString(), site: hostnameOf(tab.url), workerAge: key - workerStarted, late: true });
      const overlayTab = await openOverPicture(tab);
      // The page may still have got to it in time while its answer was on
      // its way: an overlay it opened goes, as the tab has it now, and a
      // press that closed its overlay takes the tab with it.
      injection.then(([{ result: late } = {}]) => {
        if (late?.opened) {
          chrome.scripting.executeScript({ target: { tabId: tab.id }, func: closeInPage }).catch(() => {});
        } else if (late === 'closed' && overlayTab) {
          chrome.tabs.remove(overlayTab).catch(() => {});
        }
      }, () => {});
      return;
    }
    if (result?.opened) {
      const site = hostnameOf(tab.url);
      opening.set(tab.id, { at: new Date(key).toISOString(), site, loading: tab.status === 'loading', readyState: result.readyState, workerAge: key - workerStarted, pageRan: result.opened - key, injected: Date.now() - key, key });
      setTimeout(() => opening.delete(tab.id), 10_000);
    }
    return;
  } catch (error) {
    // The page cannot host it, so the overlay opens as a tab beside it. The
    // reason stays for the session, for finding out why on a page where it
    // should have.
    await openOverlayTab(tab.windowId, async () => {
      const focused = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
      await chrome.storage.session.set({
        overlayFallback: {
          reason: String(error?.message ?? error),
          url: tab.url ?? '',
          tabId: tab.id,
          windowId: tab.windowId,
          focusedWindowId: focused?.id ?? null,
          focusedTabId: focused?.tabs?.find((other) => other.active)?.id ?? null,
          at: Date.now(),
        },
      });
      const query = new URLSearchParams({ mode: 'tab', closes: '1', back: tab.id });
      return chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true, url: chrome.runtime.getURL(`${overlayPath}?${query}`) });
    });
  }
}

// The tabs a click on the button closes in the window: every tab that is
// neither pinned nor in a tab group, apart from the selected one, or, once
// those are gone, the selected one.
function closableTabs(tabs) {
  const current = tabs.find((tab) => tab.active);
  const loose = tabs.filter((tab) => !tab.pinned && !inGroup(tab));
  const others = loose.filter((tab) => tab !== current);
  if (others.length > 0) return { tabs: others, current: false };
  return { tabs: loose.filter((tab) => tab === current), current: true };
}

// The overlay's Close Other Tabs closes only the others; the button's second
// click gives up the selected tab too.
export async function closeTabs(tab, { othersOnly = false } = {}) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const closable = closableTabs(tabs);
  if (closable.tabs.length === 0 || (closable.current && othersOnly)) return;
  if (!closable.current) {
    await chrome.tabs.remove(closable.tabs.map((other) => other.id));
    return;
  }
  // The selected tab goes too, once the overlay drawn over it has been told
  // where to go instead; Escape keeps it. Where the page cannot host the
  // overlay, the overlay takes the tab's place at once.
  try {
    const query = new URLSearchParams({ mode: 'frame', replace: '1', tab: tab.id, window: tab.windowId }).toString();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: toggleInPage, args: [overlayPath, query], injectImmediately: true });
  } catch {
    await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true, url: overlayUrl('tab', tab) });
    await chrome.tabs.remove(tab.id);
  }
}

// The button shows how many tabs a click closes in the window it sits in.
// Counts for a window run one after another, so an earlier count finishing
// late never overwrites a later one.
const counting = new Map();

export function showClosableCount(windowId) {
  const next = (counting.get(windowId) ?? Promise.resolve()).then(() => countIn(windowId));
  counting.set(windowId, next);
  next.finally(() => {
    if (counting.get(windowId) === next) counting.delete(windowId);
  });
  return next;
}

async function countIn(windowId) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return;
  }
  const active = tabs.find((tab) => tab.active);
  if (!active) return;
  const count = closableTabs(tabs).tabs.length;
  await chrome.action.setBadgeText({ tabId: active.id, text: count > 0 ? String(count) : '' }).catch(() => {});
}
