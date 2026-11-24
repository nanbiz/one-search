import { createPinSync } from './pins.js';
import { isCtrlT, overlayShortcut } from './shortcut.js';
import { closeTabs, overlayReady, replaceNewTab, showClosableCount, toggleOverlay } from './tools.js';
import { keepLearningSearch, learnFromPage, learnSearch, retryUnfound } from './site-search.js';
import { readPlaceholderUrl } from './placeholder-url.js';

const sync = createPinSync(chrome);
const normalWindows = { windowTypes: ['normal'] };

// The right-click menu of the toolbar button switches the extension off and on.
// Off, it leaves the tabs alone: pins are no longer kept alike across
// windows, Ctrl+T opens the browser's New Tab page, the button does nothing
// and turns grey, and a placeholder clicked opens its page where it is.
// Switched on again, it builds the pin list from the tabs anew, as after a
// browser start. Until the stored setting is read, events wait.
const SESSION_STATE = ['pins', 'placeholders', 'focusOrder', 'orders'];
let on = null;
const waiting = [];
const switchRead = chrome.storage.local.get('off').then(({ off }) => {
  on = !off;
  for (const hint of waiting.splice(0)) if (on) sync.note(hint);
  return on;
});

function note(hint) {
  if (on === null) waiting.push(hint);
  else if (on) sync.note(hint);
}

// The button's icon as image data, greyed while switched off.
async function buttonIcon(grey) {
  const imageData = {};
  for (const size of [16, 32]) {
    const bitmap = await createImageBitmap(await (await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))).blob());
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, size, size);
    const image = context.getImageData(0, 0, size, size);
    for (let index = 0; grey && index < image.data.length; index += 4) {
      const [red, green, blue] = image.data.slice(index, index + 3);
      const level = Math.round(0.3 * red + 0.59 * green + 0.11 * blue);
      image.data.set([level, level, level, Math.round(image.data[index + 3] * 0.55)], index);
    }
    imageData[size] = image;
  }
  return imageData;
}

async function showSwitch() {
  const { name, action } = chrome.runtime.getManifest();
  await chrome.contextMenus.update('on', { checked: on }).catch(() => {});
  await chrome.action.setTitle({ title: on ? action.default_title : `${name} is off` });
  if (on) {
    for (const window of await chrome.windows.getAll(normalWindows)) countIn(window.id);
  } else {
    for (const tab of await chrome.tabs.query({})) await chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});
  }
  await chrome.action.setIcon({ imageData: await buttonIcon(!on) }).catch((error) => console.error('Synced Pins could not draw its button', error));
}

// The menu writes the setting, and every change of it is applied here.
async function applySwitch(next) {
  await switchRead;
  if (next === on) return;
  on = next;
  // The pin list is built anew from the tabs when switched on.
  await chrome.storage.session.remove(SESSION_STATE);
  await showSwitch();
  if (on) sync.note({ type: 'layout' });
}

function createSwitchMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'on', type: 'checkbox', title: 'On', checked: on !== false, contexts: ['action'] });
  });
}
chrome.runtime.onStartup.addListener(createSwitchMenu);
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'on') chrome.storage.local.set({ off: !info.checked });
});
chrome.storage.local.onChanged.addListener(({ off }) => {
  if (off) applySwitch(!off.newValue);
});
switchRead.then(() => (on ? null : showSwitch())).catch(() => {});

const layoutChanged = () => note({ type: 'layout' });

// Once after installation the page that puts the overlay on Ctrl+T opens,
// unless it is there already. The browser can report the installation before
// it has a window to open the page in, so the page waits for the first one.
const setupPage = chrome.runtime.getURL('src/welcome.html');

async function promptSetupNow() {
  const { setupPending } = await chrome.storage.local.get('setupPending');
  if (!setupPending) return;
  const onCtrlT = isCtrlT(await overlayShortcut());
  const [window] = await chrome.windows.getAll(normalWindows);
  if (!onCtrlT && !window) return;
  // Pending until the page is open, so whoever reads it as done finds the
  // page there.
  if (!onCtrlT) await chrome.tabs.create({ windowId: window.id, url: setupPage });
  await chrome.storage.local.set({ setupPending: false });
}

// One check at a time, so a window opening during the installation does not
// open the page twice.
let prompting = Promise.resolve();
function promptSetup() {
  prompting = prompting.then(promptSetupNow).catch(() => {});
  return prompting;
}

// The browser reloads the extension when its file access is turned on, which
// closes the setup page the user went there from, so the page comes back in
// place of the tab holding the switch.
async function returnToSetup() {
  const { setupReturn } = await chrome.storage.local.get('setupReturn');
  if (!setupReturn || !await chrome.extension.isAllowedFileSchemeAccess()) return;
  await chrome.storage.local.remove('setupReturn');
  const switchPage = new RegExp(`^[a-z]+://extensions/\\?id=${chrome.runtime.id}$`);
  const tab = (await chrome.tabs.query({})).find((other) => switchPage.test(other.url));
  await chrome.tabs.create({ windowId: tab?.windowId, url: setupPage });
  if (tab) await chrome.tabs.remove(tab.id);
}
returnToSetup();

// The guide to putting the overlay on Ctrl+T opens beside the browser's own
// shortcuts page, both in the space of the window it was asked from: the page
// on the left, the guide on the right, so its steps stay in view.
async function openSetup(windowId) {
  const from = await chrome.windows.get(windowId).catch(() => null);
  const { left = 0, top = 0, width = 1280, height = 800 } = from ?? {};
  const pageWidth = Math.round(width * 0.6);
  const shortcuts = await chrome.windows.create({ url: 'chrome://extensions/shortcuts', left, top, width: pageWidth, height, focused: true });
  await chrome.windows.create({
    url: chrome.runtime.getURL(`src/welcome.html?guide&shortcuts=${shortcuts.id}`),
    type: 'popup',
    left: left + pageWidth,
    top,
    width: width - pageWidth,
    height,
  });
  await chrome.windows.update(shortcuts.id, { focused: true });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  createSwitchMenu();
  note({ type: 'installed', reason });
  if (reason === 'update') retryUnfound().catch(() => {});
  if (reason !== 'install') return;
  const { setupPending } = await chrome.storage.local.get('setupPending');
  if (setupPending === undefined) await chrome.storage.local.set({ setupPending: true });
  await promptSetup();
});
chrome.windows.onCreated.addListener(() => promptSetup(), normalWindows);
chrome.runtime.onStartup.addListener(layoutChanged);
// The browser stops an idle worker after half a minute and starts it again
// for the next event, which a shortcut arriving then waits for; an alarm as
// often as the browser allows keeps it running, so the overlay opens without
// that start.
chrome.alarms.create('keep-warm', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

// Versions that listed the tabs while Alt was held registered a page script
// for it, which outlives an update.
chrome.scripting.unregisterContentScripts({ ids: ['tab-switcher'] }).catch(() => {});
chrome.permissions.onAdded.addListener(() => keepLearningSearch().catch(() => {}));
chrome.permissions.onRemoved.addListener(() => keepLearningSearch().catch(() => {}));
keepLearningSearch().catch(() => {});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'openSearch' && sender.tab && sender.frameId === 0 && typeof message.href === 'string') {
    learnSearch(sender.url, message.href).then(respond, () => respond(null));
    return true;
  }
  if (message?.type === 'openSearchText' && sender.tab && sender.frameId === 0) learnFromPage(sender.url, message.text).catch(() => {});
  if (message === 'summon' && sender.tab) summon(sender.tab);
  if (message?.type === 'openSetup') openSetup(message.windowId);
  if (message?.type === 'overlayReady') overlayReady(message.tabId, message.frameStarted, message.ready, message.loaded);
  if (message?.type === 'closeTabs') {
    chrome.tabs.get(message.tabId).then((tab) => closeTabs(tab, { othersOnly: message.othersOnly === true })).catch(() => {});
  }
});

chrome.windows.onCreated.addListener(layoutChanged, normalWindows);
chrome.windows.onRemoved.addListener((windowId) => note({ type: 'windowRemoved', windowId }), normalWindows);
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) note({ type: 'focused', windowId });
}, normalWindows);

chrome.tabs.onActivated.addListener(({ tabId }) => note({ type: 'activated', tabId }));
chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  note({ type: 'removed', tabId, windowId, windowClosing: isWindowClosing });
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  note({ type: 'replaced', addedTabId, removedTabId });
});

// A placeholder asks for its pin's page; while switched off it opens there.
async function summon(tab) {
  if (await switchRead && on) {
    sync.note({ type: 'summon', tabId: tab.id, windowId: tab.windowId });
    return;
  }
  const pin = readPlaceholderUrl(chrome.runtime.getURL('src/placeholder.html'), tab.url);
  if (pin) await chrome.tabs.update(tab.id, { url: pin.url });
}
chrome.tabs.onCreated.addListener(layoutChanged);
chrome.tabs.onMoved.addListener(layoutChanged);
chrome.tabs.onAttached.addListener(layoutChanged);
chrome.tabs.onUpdated.addListener(layoutChanged);

// The overlay opens on the extension's shortcut, which the user can put on
// Ctrl+T, and the toolbar button closes the window's other tabs, showing how
// many it would close.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-overlay') return;
  if (await switchRead && on) toggleOverlay(tab);
  else await chrome.tabs.create({ windowId: tab?.windowId });
});
chrome.action.onClicked.addListener(async (tab) => {
  if (await switchRead && on) closeTabs(tab);
});

// A New Tab page becomes the overlay. The selected tab of each window and the
// one before it are kept, so the overlay's Escape can go back to where the
// user was.
const selection = new Map();
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const [now] = selection.get(windowId) ?? [];
  if (now !== tabId) selection.set(windowId, [tabId, now]);
});
const selectedBefore = (tab) => {
  const [now, before] = selection.get(tab.windowId) ?? [];
  return now === tab.id ? before : now;
};
chrome.tabs.onCreated.addListener((tab) => {
  if (on) replaceNewTab(tab, tab.pendingUrl || tab.url, selectedBefore(tab));
});
chrome.tabs.onUpdated.addListener((tabId, { url, pinned }, tab) => {
  if (on && (url || pinned === false)) replaceNewTab(tab, tab.pendingUrl || tab.url, selectedBefore(tab));
});
// New Tab pages opened while the worker was not running, as when the browser
// starts or the extension reloads, are turned once it runs.
switchRead.then(async () => {
  if (!on) return;
  for (const tab of await chrome.tabs.query({})) replaceNewTab(tab, tab.pendingUrl || tab.url, undefined, { found: true });
});
function countIn(windowId) {
  if (on) showClosableCount(windowId);
}
chrome.tabs.onActivated.addListener(({ windowId }) => countIn(windowId));
chrome.tabs.onCreated.addListener(({ windowId }) => countIn(windowId));
chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  if (!isWindowClosing) countIn(windowId);
});
// Chromium clears a tab's badge when the tab navigates, so the count is
// shown again whenever a page starts or finishes loading.
chrome.tabs.onUpdated.addListener((tabId, change, { windowId }) => {
  if ('pinned' in change || 'groupId' in change || 'status' in change) countIn(windowId);
});
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => countIn(newWindowId));
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => countIn(oldWindowId));
