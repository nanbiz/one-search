import { containsWords, matchScore } from './match.js';
import { browserPages, quickActions } from './quick-actions.js';
import { isCtrlT, overlayShortcut } from './shortcut.js';

// The overlay opened instead of a new tab: type an address, a search or the
// name of an action, or pick one of the open tabs or pins, and only then does
// a tab open. It runs over a page (frame) or as a tab of its own (tab).
const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'tab';
// The tab the overlay was opened for is given up for whatever is picked: the
// overlay's own tab, or the page the toolbar button's second click closes.
const replacing = mode === 'tab' || params.get('replace') === '1';
const placeholderPage = chrome.runtime.getURL('src/placeholder.html');
const overlayPage = chrome.runtime.getURL('src/overlay.html');

// Zen keeps the text of an overlay closed without a choice for this long, so
// opening it again over the same tab brings the text back.
const KEEP_QUERY_MS = 45_000;
// Actions are offered from this many letters on, unless the name matches
// exactly or from its start, and at most this many of them.
const ACTION_MIN_QUERY = 3;
const ACTION_MIN_SCORE = 92;
const ACTION_STRONG_SCORE = 100_000;
const MAX_ACTIONS = 5;
const MAX_TABS = 6;

const query = document.getElementById('query');
const chip = document.getElementById('chip');
const resultsList = document.getElementById('results');
document.body.classList.add(mode);

let target;
let tabs = [];
let pins = [];
let items = [];
let selected = 0;

function isPlaceholder(tab) {
  return (tab.pendingUrl || tab.url || '').startsWith(`${placeholderPage}?`);
}

function isOverlay(tab) {
  return (tab.pendingUrl || tab.url || '').startsWith(overlayPage);
}

// An address as the row shows it beside the title: host and path, without
// the scheme or a leading www.
function siteOf(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, '')}${pathname === '/' ? '' : pathname}`;
  } catch {
    return url;
  }
}

// History and bookmarks, once the user has let the extension read them. A
// site whose name starts with what is typed is offered as the site itself,
// ahead of the search, as the address bar completes it; single pages from
// history and bookmarks come after the open tabs. Searching history in the
// browser takes some 150 ms a word and the searches queue up while typing, so
// the most recent pages and every bookmark are read once when the overlay
// opens and each query is matched against them here.
const MAX_SITES = 2;
const MAX_PAGES = 4;
const MAX_BOOKMARKS = 3;
// The whole history is read, which takes the browser most of a second for
// ten thousand pages; the last one read is kept for the session, so the
// overlay starts from it at once and reads it afresh behind.
const FIRST_PAGES = 2000;
const ALL_PAGES = 1_000_000;
let remembered = null;

// An entry as matching needs it: its words lower-cased and its site, worked
// out once rather than on every key.
function indexed(entry) {
  const title = entry.title ?? '';
  return { url: entry.url, title, words: `${title} ${entry.url}`.toLowerCase(), host: hostOf(entry.url), weight: (entry.visitCount ?? 1) + 2 * (entry.typedCount ?? 0) };
}

function keep(history, bookmarks) {
  // Sign-in steps are passed through, never gone back to, so they are left
  // out of what the overlay offers.
  const signIn = /\/(signin|ServiceLogin|challenge)\b|\/oauth2?\//i;
  const web = (entry) => /^https?:/.test(entry.url ?? '') && !signIn.test(new URL(entry.url).pathname);
  remembered = {
    history: history.filter(web).map(indexed).sort((a, b) => b.weight - a.weight),
    bookmarks: bookmarks.filter(web).map(indexed),
  };
  if (typed.trim()) {
    render();
    complete();
  }
}

async function remember() {
  if (!chrome.history && !chrome.bookmarks) return;
  const { recallCache } = await chrome.storage.session.get('recallCache');
  if (recallCache) keep(recallCache.history, recallCache.bookmarks);
  const bookmarks = [];
  if (chrome.bookmarks) {
    const walk = (nodes) => nodes.forEach((node) => (node.url ? bookmarks.push(node) : walk(node.children ?? [])));
    walk(await chrome.bookmarks.getTree().catch(() => []));
  }
  if (!chrome.history) return keep([], bookmarks);
  if (!recallCache) keep(await chrome.history.search({ text: '', startTime: 0, maxResults: FIRST_PAGES }), bookmarks);
  const history = await chrome.history.search({ text: '', startTime: 0, maxResults: ALL_PAGES });
  keep(history, bookmarks);
  const slim = (entry) => ({ url: entry.url, title: entry.title, visitCount: entry.visitCount, typedCount: entry.typedCount });
  await chrome.storage.session.set({ recallCache: { history: history.map(slim), bookmarks: bookmarks.map(slim) } }).catch(() => {});
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isFrontPage(url) {
  try {
    const { pathname } = new URL(url);
    return pathname === '/' || pathname === '';
  } catch {
    return false;
  }
}

function withoutFragment(url) {
  return url.split('#')[0];
}

function recalled(text) {
  if (!remembered) return { sites: [], pages: [] };
  const word = text.trim().toLowerCase();
  const words = word.split(/\s+/);
  // Sites: hosts that start with the typed word, or have a part that does,
  // ranked by how often they were visited.
  const visits = new Map();
  const startsSite = (host) => host.startsWith(word) || host.includes(`.${word}`);
  for (const entry of remembered.history) {
    if (!startsSite(entry.host)) continue;
    let site = visits.get(entry.host);
    if (site) site.count += entry.weight;
    else visits.set(entry.host, site = { host: entry.host, url: entry.url, page: '', count: entry.weight });
    // The site opens on its front page, so that page's title is the one shown
    // for it, never that of another page of the site, such as Google Maps for
    // google.com.
    if (!site.page && isFrontPage(entry.url)) site.page = entry.title;
  }
  const sites = [...visits.values()]
    .sort((a, b) => (b.host.startsWith(word) - a.host.startsWith(word)) || b.count - a.count)
    .slice(0, MAX_SITES)
    .map((site) => {
      const url = `${new URL(site.url).origin}/`;
      return { title: site.host, url, favIconUrl: null, kind: 'Site', page: site.page, pick: () => openAddress(url) };
    });
  // A page shows once, whatever its fragment, and pages of one site with the
  // same title, such as a page reached with different parameters, once too.
  const shown = new Set();
  const seen = (url, title) => {
    const keys = [withoutFragment(url), `${hostOf(url)} ${title ?? ''}`];
    if (keys.some((key) => shown.has(key))) return true;
    keys.forEach((key) => shown.add(key));
    return false;
  };
  for (const item of [...tabs, ...pins, ...sites.map((site) => ({ url: site.url, title: site.title }))]) {
    if (item.url) shown.add(withoutFragment(item.url));
  }
  const take = (entries, max, kind) => {
    const found = [];
    for (const entry of entries) {
      if (found.length === max) break;
      if (!words.every((part) => entry.words.includes(part)) || seen(entry.url, entry.title)) continue;
      found.push({ title: entry.title || siteOf(entry.url), url: entry.url, favIconUrl: null, kind, pick: () => openAddress(entry.url) });
    }
    return found;
  };
  return { sites, pages: [...take(remembered.history, MAX_PAGES, 'History'), ...take(remembered.bookmarks, MAX_BOOKMARKS, 'Bookmark')] };
}

// Sites with a search of their own, from the list shipped with the extension
// and the ones learned from the sites visited, each with the address that
// searches it, {{{s}}} standing for the search. Read once the overlay shows,
// as the list is large.
let searchAddresses = null;

async function readSearchAddresses() {
  const [shipped, { learnedSearch = {} }] = await Promise.all([
    fetch(chrome.runtime.getURL('src/site-search.json')).then((response) => response.json()).catch(() => ({})),
    chrome.storage.local.get('learnedSearch'),
  ]);
  searchAddresses = { ...learnedSearch, ...shipped };
  if (!numberMode && !siteSearch) render();
}

function searchAddressOf(url) {
  const host = hostOf(url ?? '');
  return host && searchAddresses ? searchAddresses[host] ?? null : null;
}

// Searching one site: Tab on a site that has a search of its own puts the
// site in the field, and what is typed then searches it.
let siteSearch = null;

function enterSiteSearch(item) {
  siteSearch = { host: hostOf(item.url), url: item.url, address: searchAddressOf(item.url) };
  chip.replaceChildren(iconImage(item.url, null), Object.assign(document.createElement('span'), { textContent: siteSearch.host }));
  chip.hidden = false;
  query.placeholder = '';
  uncomplete();
  typed = '';
  query.value = '';
  selected = 0;
  render();
}

function leaveSiteSearch() {
  siteSearch = null;
  chip.hidden = true;
  query.placeholder = 'Search or enter address';
  selected = 0;
  render();
}

function siteSearchItems(text) {
  if (!text.trim()) return [];
  const url = siteSearch.address.replaceAll('{{{s}}}', encodeURIComponent(text.trim()));
  return [{ title: text.trim(), url: siteSearch.url, favIconUrl: null, kind: 'Search', site: siteSearch.host, pick: () => openAddress(url) }];
}

// A pin's name: its own title, else that of its open tab, else its site.
function pinName(pin) {
  const live = tabs.find((tab) => tab.id === pin.tabId && !isPlaceholder(tab));
  if (pin.title || live?.title) return pin.title || live.title;
  try {
    return new URL(pin.url).hostname.replace(/^www\./, '');
  } catch {
    return pin.url;
  }
}

// An icon element that falls back to the browser's own copy of the site's
// icon where the site does not let other pages load it.
function iconImage(url, favIconUrl) {
  const icon = document.createElement('img');
  icon.alt = '';
  icon.src = iconFor(url, favIconUrl);
  icon.addEventListener('error', () => {
    const stored = iconFor(url, null);
    if (icon.src !== stored) icon.src = stored;
  }, { once: true });
  return icon;
}

function iconFor(url, favIconUrl) {
  if (favIconUrl && !favIconUrl.startsWith('chrome://')) return favIconUrl;
  return chrome.runtime.getURL(`/_favicon/?${new URLSearchParams({ pageUrl: url, size: 32 })}`);
}

// The file address of a path as a file manager or a title bar gives it, in the
// quotes of Windows' Copy as path or without: on a drive, on a network share or,
// outside Windows, from the root. A path from the root holds no spaces, since
// text like "/r/rust memes" is a search. Every character of a path is literal,
// so one like # or % is escaped.
function fileAddressOf(value) {
  const path = value.replace(/^"(.*)"$/, '$1');
  const slashed = path.replaceAll('\\', '/');
  const escaped = (text) => text.split('/').map(encodeURIComponent).join('/');
  if (/^[a-z]:\//i.test(slashed)) return `file:///${slashed.slice(0, 2)}${escaped(slashed.slice(2))}`;
  if (path.startsWith('\\\\')) return `file:${escaped(slashed)}`;
  if (path.startsWith('/') && !/\s/.test(path) && !navigator.platform.startsWith('Win')) return `file://${escaped(path)}`;
  return null;
}

// Turns typed text into an address where it reads as one: a path, a scheme, or
// one word with a dot, a port or localhost.
function addressOf(text) {
  const value = text.trim();
  if (!value) return null;
  const file = fileAddressOf(value);
  if (file) return file;
  if (/\s/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(about|chrome|data|file|view-source):/i.test(value)) return value;
  const host = value.split(/[/?#]/)[0];
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(host)) return `http://${value}`;
  if (/^[^.:]+(\.[^.:]+)*\.[a-z]{2,}(:\d+)?$/i.test(host) || /^\[[0-9a-f:]+\](:\d+)?$/i.test(host)) return `https://${value}`;
  return null;
}

function close() {
  if (mode === 'frame') window.parent.postMessage('synced-pins:close', '*');
}

// Leaving without a choice. The overlay that took a New Tab page's place goes
// with its tab, back to the tab selected before, as long as the window keeps
// another tab.
async function dismiss() {
  // A key pressed while the overlay starts acts once it knows its own tab.
  await started;
  await keepQuery();
  if (mode === 'tab' && (params.get('newtab') === '1' || params.get('closes') === '1') && target) {
    const others = (await chrome.tabs.query({ windowId: target.windowId })).filter((tab) => tab.id !== target.id);
    if (others.length > 0) {
      const back = others.find((tab) => tab.id === Number(params.get('back')));
      if (back) await chrome.tabs.update(back.id, { active: true });
      await chrome.tabs.remove(target.id);
      return;
    }
  }
  close();
}

async function keepQuery() {
  // A search of one site is not kept: its text alone would come back as a
  // search of the web.
  const text = siteSearch ? '' : typed;
  await chrome.storage.session.set({ overlayQuery: { text, tabId: target?.id, at: Date.now() } });
}

async function forgetQuery() {
  await chrome.storage.session.remove('overlayQuery');
}

// A page picked loads in the tab being given up; elsewhere it opens in a new
// tab, as Zen opens it.
async function openAddress(address) {
  // The browser refuses a local file without its file access, so the address
  // leads to the page holding that switch.
  const url = isFileAddress(address) && !filesAllowed ? filesPage : address;
  if (replacing) await chrome.tabs.update(target.id, { url });
  else await chrome.tabs.create({ windowId: target.windowId, url });
}

async function search(text) {
  if (replacing) await chrome.search.query({ text, tabId: target.id });
  else await chrome.search.query({ text, disposition: 'NEW_TAB' });
}

// Switching to another tab closes the tab being given up.
async function leaveOwnTab() {
  if (replacing) await chrome.tabs.remove(target.id);
}

async function selectTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== target.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  await leaveOwnTab();
}

// A pin is selected in this window: its live tab where it lives here, or its
// placeholder, which brings the live page over.
async function selectPin(pin) {
  const here = tabs.filter((tab) => tab.windowId === target.windowId);
  const live = here.find((tab) => tab.id === pin.tabId);
  const placeholder = here.find((tab) => isPlaceholder(tab)
    && new URLSearchParams((tab.pendingUrl || tab.url).split('?')[1]).get('pin') === pin.id);
  const tab = live ?? placeholder ?? tabs.find((other) => other.id === pin.tabId);
  if (tab) await selectTab(tab);
}

function pinItems(text) {
  return pins
    .filter((pin) => containsWords(text, `${pin.title ?? ''} ${pin.url}`))
    .map((pin) => ({ title: pinName(pin), url: pin.url, favIconUrl: pin.favIconUrl, kind: 'Switch to Tab', pick: () => selectPin(pin) }));
}

function tabItems(text) {
  return tabs
    .filter((tab) => tab.id !== target.id && !tab.pinned && !isPlaceholder(tab) && !isOverlay(tab))
    .filter((tab) => containsWords(text, `${tab.title ?? ''} ${tab.url ?? ''}`))
    .slice(0, MAX_TABS)
    .map((tab) => ({ title: tab.title || tab.url, url: tab.url, favIconUrl: tab.favIconUrl, kind: 'Switch to Tab', pick: () => selectTab(tab) }));
}

function actionItems(text) {
  const actions = quickActions
    .filter((action) => action.available(target))
    .map((action) => ({ title: action.label, icon: action.icon, kind: 'Action', pick: () => action.run(target) }));
  const pages = browserPages()
    .map((page) => ({ title: page.label, icon: page.icon, site: page.address, kind: page.kind, pick: () => openAddress(page.address) }));
  return [...actions, ...pages]
    .map((item) => ({ item, score: matchScore(text, item.title) }))
    .filter(({ score }) => score !== null
      && (score >= ACTION_STRONG_SCORE || (text.trim().length >= ACTION_MIN_QUERY && score > ACTION_MIN_SCORE)))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ACTIONS)
    .map(({ item }) => ({ ...item, glyph: true }));
}

function results(text) {
  if (!text.trim()) return [];
  const address = addressOf(text);
  const searchItem = { title: text.trim(), icon: chrome.runtime.getURL('src/search.svg'), glyph: true, kind: 'Search', pick: () => search(text.trim()) };
  const first = address
    ? [{ title: address, url: address, favIconUrl: null, kind: 'Open', pick: () => openAddress(address) }]
    : [searchItem];
  const { sites, pages } = recalled(text);
  // A visited site whose address starts with what is typed comes first, even
  // where the text reads as an address of its own ("photos.go" is on its way
  // to photos.google.com); otherwise a typed address opens as it is.
  const typedLower = text.trim().toLowerCase();
  const siteAhead = sites.some((site) => site.title.startsWith(typedLower) && site.title !== typedLower);
  return [
    ...actionItems(text),
    ...(!address || siteAhead ? sites : []),
    ...first,
    ...(address && !siteAhead ? sites : []),
    ...pinItems(text),
    ...tabItems(text),
    ...pages,
    ...(address ? [searchItem] : []),
  ];
}

// Each of the window's tabs has a key that picks it: Alt with the key, or
// the key alone in number mode. Single keys come first, 1 to 9 then a to z,
// and from the 36th tab on 0 followed by one of them.
const KEYS = '123456789abcdefghijklmnopqrstuvwxyz';

function keyOf(index) {
  if (index < KEYS.length) return KEYS[index];
  return index < 2 * KEYS.length ? `0${KEYS[index - KEYS.length]}` : '';
}

// The tab the overlay stands for: the page it is drawn over, or, as a tab of
// its own, the tab it was opened from.
function currentTabId() {
  return mode === 'frame' ? target?.id : Number(params.get('back'));
}

// The window's tabs in the order of its tab strip, pinned ones first as the
// strip has them; a pin's placeholder is shown as its pin.
function tabRows() {
  const pinOf = (tab) => pins.find((pin) => pin.tabId === tab.id)
    ?? (isPlaceholder(tab) ? pins.find((pin) => pin.id === new URLSearchParams((tab.pendingUrl || tab.url).split('?')[1]).get('pin')) : undefined);
  return tabs
    .filter((tab) => tab.windowId === target.windowId && !isOverlay(tab))
    .sort((a, b) => a.index - b.index)
    .map((tab, index) => {
      const pin = pinOf(tab);
      const current = tab.id === currentTabId();
      return {
        title: pin ? pinName(pin) : tab.title || tab.url,
        url: pin ? pin.url : tab.pendingUrl || tab.url,
        favIconUrl: pin ? pin.favIconUrl : tab.favIconUrl,
        kind: current ? 'Current' : tab.pinned ? 'Pinned' : '',
        key: keyOf(index),
        tabId: tab.id,
        current,
        pick: () => (pin ? selectPin(pin) : selectTab(tab)),
      };
    });
}

// With nothing typed, or in number mode, the overlay lists the window's
// tabs; nothing is selected until the arrow keys move into the list.
function listingTabs() {
  return numberMode || (!siteSearch && !typed.trim());
}

// Rows of tabs in number mode run down in columns, as many as it takes to
// keep a column to ten, up to four.
const PER_COLUMN = 10;
const MAX_COLUMNS = 4;

function render() {
  const text = typed;
  showFilesOffer();
  items = listingTabs() ? tabRows() : siteSearch ? siteSearchItems(text) : results(text);
  selected = Math.min(selected, Math.max(items.length - 1, 0));
  const columns = numberMode ? Math.min(MAX_COLUMNS, Math.max(1, Math.ceil(items.length / PER_COLUMN))) : 1;
  box.classList.toggle('numbers', numberMode);
  document.body.classList.toggle('numbers', numberMode);
  box.dataset.columns = String(columns);
  resultsList.style.gridTemplateRows = columns > 1 ? `repeat(${Math.ceil(items.length / columns)}, auto)` : '';
  resultsList.replaceChildren();
  items.forEach((item, index) => {
    const element = row(item);
    if (item.tabId !== undefined) element.dataset.key = String(item.tabId);
    const isSelected = index === selected && (!listingTabs() || keyboardOnPins);
    element.classList.toggle('selected', isSelected);
    // The selected site that has a search of its own takes Tab to search it.
    if (isSelected && item.kind === 'Site' && searchAddressOf(item.url)) {
      const key = document.createElement('span');
      key.className = 'tabkey';
      key.append(Object.assign(document.createElement('img'), { src: 'tab.svg', alt: '', className: 'glyph' }), 'Tab');
      element.querySelector('.kind').before(key);
    }
    element.classList.toggle('current', item.current === true);
    element.addEventListener('mousedown', (event) => event.preventDefault());
    element.addEventListener('click', () => pick(index));
    resultsList.append(element);
  });
  resultsList.querySelector('.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function row(item) {
  const element = document.createElement('div');
  element.className = 'row';
  element.setAttribute('role', 'option');
  const icon = item.icon ? document.createElement('img') : iconImage(item.url, item.favIconUrl);
  if (item.icon) {
    icon.src = item.icon;
    icon.alt = '';
  }
  icon.classList.toggle('glyph', Boolean(item.glyph));
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.title;
  const site = document.createElement('span');
  site.className = 'site';
  site.textContent = item.site ?? (item.url && item.kind !== 'Open' && item.kind !== 'Site' ? siteOf(item.url) : '');
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = item.kind;
  if (item.key !== undefined) {
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = item.key;
    element.append(key);
  }
  element.append(icon, title, site, kind);
  return element;
}

// The list of tabs takes the selection only once the arrow keys reach it.
let keyboardOnPins = false;

async function pick(index) {
  const item = items[index];
  if (!item) return;
  // Over a page the overlay is hidden, and that painted, before it acts: the
  // page left behind keeps its last picture until it is shown again.
  if (mode === 'frame') {
    // The page confirms once it has painted the overlay hidden; a frame the
    // browser no longer draws gets no animation frames of its own to wait on.
    await new Promise((resolve) => {
      const done = () => {
        window.removeEventListener('message', onHidden);
        resolve();
      };
      const onHidden = (event) => {
        if (event.source === window.parent && event.data === 'synced-pins:hidden') done();
      };
      window.addEventListener('message', onHidden);
      setTimeout(done, 100);
      window.parent.postMessage('synced-pins:hide', '*');
    });
  }
  await forgetQuery();
  try {
    await item.pick();
  } finally {
    close();
  }
}

function move(step) {
  if (items.length === 0) return;
  if (listingTabs() && !keyboardOnPins) {
    keyboardOnPins = true;
    selected = step > 0 ? 0 : items.length - 1;
  } else {
    selected = (selected + step + items.length) % items.length;
  }
  uncomplete();
  render();
}

// What the user typed; the field can hold more, the rest of an address the
// overlay fills in and selects, as the address bar completes one.
let typed = '';
let completing = false;
const hint = document.getElementById('hint');
const measure = document.createElement('canvas').getContext('2d');

// Fills in the rest of the top row's site after what was typed, selected so
// the next key replaces it, with the icon and title of the page that opens,
// the site's front page, behind it.
function complete() {
  const top = items[0];
  if (siteSearch || !completing || selected !== 0 || !top || top.kind !== 'Site' || !typed || /\s/.test(typed)
    || !top.title.toLowerCase().startsWith(typed.toLowerCase()) || top.title.length === typed.length) {
    uncomplete();
    return;
  }
  query.value = typed + top.title.slice(typed.length);
  query.setSelectionRange(typed.length, query.value.length, 'forward');
  query.classList.add('completing');
  const style = getComputedStyle(query);
  measure.font = `${style.fontSize} ${style.fontFamily}`;
  hint.style.left = `${query.offsetLeft + measure.measureText(query.value).width + 14}px`;
  hint.replaceChildren(iconImage(top.url, null), Object.assign(document.createElement('span'), { textContent: top.page || top.title }));
  hint.hidden = false;
}

function uncomplete() {
  hint.hidden = true;
  query.classList.remove('completing');
  if (query.value !== typed) {
    query.value = typed;
    query.setSelectionRange(typed.length, typed.length);
  }
}

// Keys typed over the page before the overlay had the keyboard come from the
// page once the overlay is ready. They were typed before anything typed here,
// so they go in front of it, or in place of a kept query still selected.
let typedHere = false;
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || typeof event.data?.syncedPinsTyped !== 'string') return;
  const text = event.data.syncedPinsTyped;
  if (typedHere) query.setRangeText(text, 0, 0, 'preserve');
  else query.setRangeText(text, query.selectionStart, query.selectionEnd, 'end');
  query.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text }));
});

query.addEventListener('input', (event) => {
  if (event.isTrusted) typedHere = true;
  typed = query.value;
  completing = event.inputType?.startsWith('insert') ?? true;
  selected = 0;
  keyboardOnPins = false;
  render();
  complete();
});

// The filled-in rest becomes typed text with the arrow or End key.
query.addEventListener('keydown', (event) => {
  const filled = query.value !== typed && query.selectionEnd === query.value.length;
  if (filled && (event.key === 'ArrowRight' || event.key === 'End')) {
    event.preventDefault();
    typed = query.value;
    hint.hidden = true;
    query.classList.remove('completing');
    query.setSelectionRange(typed.length, typed.length);
    selected = 0;
    render();
  }
});

// Number mode: Alt tapped on its own turns typing off and the tabs' keys on,
// so a key alone picks its tab; Alt again turns typing back on, with what was
// typed kept, and Escape closes the overlay as it always does.
const box = document.getElementById('box');
let numberMode = false;
// The first half of a two key label, 0, waiting for the second.
let pendingKey = '';
let altAlone = false;

// A change of the box moves what stays from where it was to where it goes,
// and fades in what is new: each tab's row slides to its new place and the
// box's surface scales to its new size. Only position, scale and opacity
// move, which the browser animates without laying the page out again on each
// frame, so the motion stays smooth while the overlay's process is busy.
const GLIDE = { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
const sheet = document.getElementById('sheet');

function placeSheet() {
  const { left, top, width, height } = box.getBoundingClientRect();
  Object.assign(sheet.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
}

function rowPlaces() {
  return new Map([...resultsList.querySelectorAll('.row[data-key]')].map((row) => [row.dataset.key, row.getBoundingClientRect()]));
}

function glide(change) {
  const before = box.getBoundingClientRect();
  const rows = rowPlaces();
  change();
  placeSheet();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const after = box.getBoundingClientRect();
  if (after.width > 0 && after.height > 0 && (before.width !== after.width || before.height !== after.height || before.top !== after.top)) {
    sheet.animate([
      { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
      { transform: 'none' },
    ], GLIDE);
  }
  for (const row of resultsList.querySelectorAll('.row')) {
    const was = rows.get(row.dataset.key);
    if (!was) {
      row.animate([{ opacity: 0 }, { opacity: 1 }], GLIDE);
      continue;
    }
    const now = row.getBoundingClientRect();
    if (was.left !== now.left || was.top !== now.top) {
      row.animate([{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px)` }, { transform: 'none' }], GLIDE);
    }
  }
}

// The surface follows the box whenever its size changes otherwise, as with
// each key typed.
new ResizeObserver(placeSheet).observe(box);
window.addEventListener('resize', placeSheet);
window.addEventListener('scroll', placeSheet, true);

function setNumberMode(on) {
  numberMode = on;
  pendingKey = '';
  keyboardOnPins = false;
  selected = 0;
  if (on) uncomplete();
  glide(render);
  if (!on) complete();
}

// The key a keyboard event stands for as a tab's label, read from the key's
// place so Alt, which changes the character on some layouts, keeps it.
function labelKey(event) {
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(event.code);
  return letter ? letter[1].toLowerCase() : null;
}

function pickKey(label) {
  const index = items.findIndex((item) => item.key === label);
  if (index !== -1) pick(index);
}

document.addEventListener('keydown', (event) => {
  const key = event.key;
  altAlone = key === 'Alt' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (key === 'Alt') {
    event.preventDefault();
    return;
  }
  // Alt with a tab's key picks that tab, whatever is typed.
  const label = labelKey(event);
  if (label && label !== '0' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !navigator.platform.startsWith('Mac')) {
    event.preventDefault();
    if (!listingTabs()) {
      items = tabRows();
    }
    pickKey(label);
    return;
  }
  if (numberMode && !event.ctrlKey && !event.metaKey && !event.altKey && label) {
    event.preventDefault();
    if (pendingKey) {
      pickKey(pendingKey + label);
      pendingKey = '';
    } else if (label === '0') {
      pendingKey = '0';
    } else {
      pickKey(label);
    }
    return;
  }
  if (key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !numberMode && !siteSearch) {
    const item = items[selected];
    if (item?.kind === 'Site' && searchAddressOf(item.url)) {
      event.preventDefault();
      enterSiteSearch(item);
      return;
    }
  }
  if (key === 'Backspace' && siteSearch && !numberMode && query.value === '') {
    event.preventDefault();
    leaveSiteSearch();
    return;
  }
  if (key === 'Escape') {
    event.preventDefault();
    dismiss();
  } else if (numberMode && key.length === 1 && !event.ctrlKey && !event.metaKey) {
    // Typing is off in number mode.
    event.preventDefault();
  } else if (key === 'ArrowDown' || (event.ctrlKey && key === 'n')) {
    event.preventDefault();
    move(1);
  } else if (key === 'ArrowUp' || (event.ctrlKey && key === 'p')) {
    event.preventDefault();
    move(-1);
  } else if (key === 'Enter') {
    event.preventDefault();
    if (!listingTabs() || keyboardOnPins) pick(selected);
  }
});

document.addEventListener('keyup', (event) => {
  if (event.key !== 'Alt') return;
  event.preventDefault();
  if (altAlone) setNumberMode(!numberMode);
  altAlone = false;
});

// Alt let go outside the overlay is no tap.
window.addEventListener('blur', () => {
  altAlone = false;
});

// A click beside the box over a page closes the overlay, as clicking outside
// Zen's address bar does.
document.addEventListener('mousedown', (event) => {
  if (mode === 'frame' && !document.getElementById('box').contains(event.target)) {
    dismiss();
  }
});

window.addEventListener('focus', () => query.focus());

function isFileAddress(text) {
  return /^file:/i.test(addressOf(text) ?? '');
}

const filesOffer = document.getElementById('files');
const filesPage = `chrome://extensions/?id=${chrome.runtime.id}`;
let filesAllowed = true;
let filesDismissed = false;
let onFilePage = false;

// Offered while the browser keeps the extension from local files, over one or
// with one typed, until the user turns that on or dismisses the row.
function showFilesOffer() {
  filesOffer.hidden = filesAllowed || filesDismissed || !(onFilePage || isFileAddress(typed));
}

for (const button of filesOffer.querySelectorAll('button')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}
document.getElementById('files-allow').addEventListener('click', async () => {
  await openAddress(filesPage);
  close();
});
document.getElementById('files-dismiss').addEventListener('click', async () => {
  filesDismissed = true;
  showFilesOffer();
  query.focus();
  await chrome.storage.local.set({ filesDismissed: true });
});

const setup = document.getElementById('setup');

// The row stays until the overlay is on Ctrl+T or the row is dismissed.
async function offerSetup() {
  const [shortcut, { setupDismissed }] = await Promise.all([
    overlayShortcut(),
    chrome.storage.local.get('setupDismissed'),
  ]);
  setup.hidden = setupDismissed || isCtrlT(shortcut);
}

for (const button of setup.querySelectorAll('button')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}
document.getElementById('setup-open').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'openSetup', windowId: target?.windowId });
  close();
});
document.getElementById('setup-dismiss').addEventListener('click', async () => {
  setup.hidden = true;
  query.focus();
  await chrome.storage.local.set({ setupDismissed: true });
});

const pagesOffer = document.getElementById('pages');
const PAGES = { origins: ['<all_urls>'] };

// Offered where the overlay had to open as a tab for a New Tab page, until
// the user lets it draw on pages or dismisses the row.
async function offerPages() {
  if (mode !== 'tab' || params.get('newtab') !== '1') return;
  const [allowed, { pagesDismissed }] = await Promise.all([
    chrome.permissions.contains(PAGES),
    chrome.storage.local.get('pagesDismissed'),
  ]);
  pagesOffer.hidden = allowed || pagesDismissed === true;
}

for (const button of pagesOffer.querySelectorAll('button')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}
document.getElementById('pages-allow').addEventListener('click', async () => {
  const allowed = await chrome.permissions.request(PAGES).catch(() => false);
  if (allowed) pagesOffer.hidden = true;
  query.focus();
});
document.getElementById('pages-dismiss').addEventListener('click', async () => {
  pagesOffer.hidden = true;
  query.focus();
  await chrome.storage.local.set({ pagesDismissed: true });
});

const historyOffer = document.getElementById('history');
const RECALL = { permissions: ['history', 'bookmarks'] };

// The row stays until history and bookmarks may be read or it is dismissed.
async function offerHistory() {
  const [allowed, { historyDismissed }] = await Promise.all([
    chrome.permissions.contains(RECALL),
    chrome.storage.local.get('historyDismissed'),
  ]);
  historyOffer.hidden = allowed || historyDismissed === true;
}

for (const button of historyOffer.querySelectorAll('button')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}
document.getElementById('history-allow').addEventListener('click', async () => {
  const allowed = await chrome.permissions.request(RECALL).catch(() => false);
  if (!allowed) return;
  historyOffer.hidden = true;
  query.focus();
  await remember();
});
document.getElementById('history-dismiss').addEventListener('click', async () => {
  historyOffer.hidden = true;
  query.focus();
  await chrome.storage.local.set({ historyDismissed: true });
});

async function start() {
  offerSetup();
  offerHistory();
  offerPages();
  // Everything the first picture needs is read at once.
  let self;
  let dismissals;
  let kept;
  [self, tabs, { pins = [] }, filesAllowed, dismissals, { overlayQuery: kept }] = await Promise.all([
    mode === 'tab' ? chrome.tabs.getCurrent() : null,
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.storage.session.get('pins'),
    chrome.extension.isAllowedFileSchemeAccess(),
    chrome.storage.local.get('filesDismissed'),
    chrome.storage.session.get('overlayQuery'),
    params.get('picture') === '1' ? chrome.storage.session.get('overlayPicture') : {},
  ]).then((read) => {
    // Opened as a tab because the page was busy: the page's picture, dimmed
    // and blurred, stands behind the box as the page itself would.
    const { overlayPicture } = read.pop();
    if (overlayPicture && overlayPicture.tabId === Number(params.get('back'))) {
      document.body.classList.add('picture');
      document.body.style.setProperty('--picture', `url("${overlayPicture.image}")`);
      chrome.storage.session.remove('overlayPicture').catch(() => {});
    }
    return read;
  });
  const loaded = Date.now();
  filesDismissed = dismissals.filesDismissed === true;
  onFilePage = isFileAddress(tabs.find((tab) => tab.id === Number(params.get('back')))?.url ?? '');
  pins = pins.filter((pin) => pin.url);
  target = self ?? tabs.find((tab) => tab.id === Number(params.get('tab')));
  if (!target) {
    close();
    return;
  }
  if (kept && !typedHere && kept.tabId === target.id && Date.now() - kept.at < KEEP_QUERY_MS) {
    query.value = kept.text;
    typed = kept.text;
    query.select();
  }
  // The box opens out from the bar the page drew while this frame loaded.
  glide(render);
  query.focus();
  // History is read and indexed once the overlay shows, since thousands of
  // pages hold up its first picture by tens of milliseconds; text typed
  // before then gets its history rows when the index is ready.
  requestAnimationFrame(() => {
    if (mode === 'frame') {
      window.parent.postMessage('synced-pins:ready', '*');
      chrome.runtime.sendMessage({ type: 'overlayReady', tabId: target.id, frameStarted: performance.timeOrigin, loaded, ready: Date.now() }).catch(() => {});
    }
    setTimeout(remember);
    setTimeout(readSearchAddresses);
  });
}

const started = start();
