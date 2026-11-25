import { isOpen } from './placeholder-url.js';

// Versions that shared pinned tabs across windows kept the list of pins, and
// the browser closes the tabs that stood in for them when the extension is
// updated. Each pin whose page is open nowhere is opened once more, pinned, as
// an ordinary pinned tab, and the list goes.
let running = null;

export function retirePins() {
  running ??= retire().finally(() => {
    running = null;
  });
  return running;
}

async function retire() {
  const { pins, off } = await chrome.storage.local.get(['pins', 'off']);
  if (!pins) return;
  const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!window || window.incognito) return;
  const open = off ? [] : pins.filter((pin) => pin.url && !pin.url.startsWith('chrome-extension:'));
  for (const pin of open) {
    const tabs = await chrome.tabs.query({});
    if (isOpen(tabs, pin.url) || isOpen(tabs, pin.home?.url)) continue;
    const index = tabs.filter((tab) => tab.windowId === window.id && tab.pinned).length;
    const tab = await chrome.tabs.create({ windowId: window.id, url: pin.home?.url ?? pin.url, index, pinned: true, active: false });
    // Vivaldi opens it unpinned.
    if (!tab.pinned) await chrome.tabs.update(tab.id, { pinned: true });
  }
  // A window left without a tab got a pinned New Tab page from the browser.
  for (const tab of await chrome.tabs.query({ pinned: true })) {
    if (/^[a-z]+:\/\/newtab\/?$/.test(tab.pendingUrl || tab.url)) await chrome.tabs.update(tab.id, { pinned: false });
  }
  await chrome.storage.local.remove(['pins', 'trace']);
}
