// The actions the overlay offers by name, as Zen's address bar does, acting
// on the tab the overlay was opened over. Each is offered only where it can
// do something.
function isWebPage(tab) {
  return /^(https?|file):/.test(tab.url ?? '');
}

async function selectNeighbour(tab, step) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const at = tabs.findIndex((other) => other.id === tab.id);
  const next = tabs[(at + step + tabs.length) % tabs.length];
  await chrome.tabs.update(next.id, { active: true });
}

export const quickActions = [
  { label: 'Pin Tab', icon: 'pin.svg', available: (tab) => !tab.pinned, run: (tab) => chrome.tabs.update(tab.id, { pinned: true }) },
  { label: 'Unpin Tab', icon: 'pin-off.svg', available: (tab) => tab.pinned, run: (tab) => chrome.tabs.update(tab.id, { pinned: false }) },
  { label: 'Close Tab', icon: 'x.svg', available: () => true, run: (tab) => chrome.tabs.remove(tab.id) },
  {
    label: 'Close Other Tabs', icon: 'copy-x.svg',
    available: () => true,
    run: (tab) => chrome.runtime.sendMessage({ type: 'closeTabs', tabId: tab.id, othersOnly: true }),
  },
  { label: 'Duplicate Current Tab', icon: 'copy.svg', available: isWebPage, run: (tab) => chrome.tabs.duplicate(tab.id) },
  { label: 'Reload Tab', icon: 'rotate-cw.svg', available: isWebPage, run: (tab) => chrome.tabs.reload(tab.id) },
  { label: 'Reload Tab Without Cache', icon: 'refresh-cw-off.svg', available: isWebPage, run: (tab) => chrome.tabs.reload(tab.id, { bypassCache: true }) },
  { label: 'Next Tab', icon: 'arrow-right.svg', available: () => true, run: (tab) => selectNeighbour(tab, 1) },
  { label: 'Previous Tab', icon: 'arrow-left.svg', available: () => true, run: (tab) => selectNeighbour(tab, -1) },
  { label: 'Copy Current URL', icon: 'link.svg', available: isWebPage, run: (tab) => navigator.clipboard.writeText(tab.url) },
  { label: 'Open New Window', icon: 'app-window.svg', available: () => true, run: () => chrome.windows.create({}) },
  { label: 'Open Private Window', icon: 'venetian-mask.svg', available: () => true, run: () => chrome.windows.create({ incognito: true }) },
  {
    label: 'Print', icon: 'printer.svg',
    available: isWebPage,
    run: (tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => print() }),
  },
];

// The browser's own pages, offered by name like the actions and opened like
// an address. Brave and Edge name their pages with their own scheme and have
// some of their own; Chromium, Helium, Vivaldi and others open chrome://.
const BROWSERS = [
  { brand: 'Brave', name: 'Brave', scheme: 'brave' },
  { brand: 'Microsoft Edge', name: 'Edge', scheme: 'edge' },
];

const COMMON_PAGES = [
  { label: 'History', path: 'history', icon: 'history.svg' },
  { label: 'Downloads', path: 'downloads', icon: 'download.svg' },
  { label: 'Bookmarks', path: 'bookmarks', icon: 'bookmark.svg' },
  { label: 'Settings', path: 'settings', icon: 'settings.svg' },
  { label: 'Extensions', path: 'extensions', icon: 'puzzle.svg' },
  { label: 'Extension Shortcuts', path: 'extensions/shortcuts', icon: 'keyboard.svg' },
  { label: 'Passwords', path: 'password-manager', icon: 'key-round.svg' },
  { label: 'Clear Browsing Data', path: 'settings/clearBrowserData', icon: 'trash-2.svg' },
  { label: 'Search Engines', path: 'settings/searchEngines', icon: 'search.svg' },
  { label: 'Site Settings', path: 'settings/content', icon: 'sliders-horizontal.svg' },
  { label: 'Privacy and Security', path: 'settings/privacy', icon: 'lock.svg' },
  { label: 'Flags', path: 'flags', icon: 'flask-conical.svg' },
  { label: 'Version', path: 'version', icon: 'info.svg' },
];

const OWN_PAGES = {
  Brave: [
    { label: 'Shields', path: 'settings/shields', icon: 'shield.svg' },
    { label: 'Rewards', path: 'rewards', icon: 'gem.svg' },
    { label: 'Wallet', path: 'wallet', icon: 'wallet.svg' },
  ],
  Edge: [],
};

// Edge calls its bookmarks favorites and keeps passwords in its settings.
const RENAMED = {
  Edge: { bookmarks: { label: 'Favorites', path: 'favorites' }, 'password-manager': { path: 'settings/passwords' } },
};

export function browserPages(brands = navigator.userAgentData?.brands ?? []) {
  const browser = BROWSERS.find(({ brand }) => brands.some((entry) => entry.brand === brand));
  const name = browser?.name;
  const scheme = browser?.scheme ?? 'chrome';
  return [...COMMON_PAGES, ...(OWN_PAGES[name] ?? [])].map((page) => {
    const { label, path } = { ...page, ...RENAMED[name]?.[page.path] };
    return { label, icon: page.icon, address: `${scheme}://${path}`, kind: name ?? 'Browser' };
  });
}
