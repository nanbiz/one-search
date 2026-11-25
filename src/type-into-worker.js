// The worker's side of typing into a page: the sites whose page has a main
// text box, learned where they are visited, and opening one to type into.

const PAGES = { origins: ['<all_urls>'] };
// Sites known, at most this many, the oldest going first.
const MAX_SITES = 2000;
// How long a site has to get to its page, past a sign-in say, and how long
// the page then has to show its box.
const ARRIVE_MS = 60_000;
const BOX_MS = 15_000;
let writing = Promise.resolve();

const hostOf = (url) => new URL(url).hostname.replace(/^www\./, '');

// An address that is the site's own start rather than one of its documents: a
// path of plain words, without a query.
function startOf(pageUrl) {
  const { origin, pathname } = new URL(pageUrl);
  return /^(\/[a-z-]{1,24}){0,2}\/?$/i.test(pathname) ? `${origin}${pathname}` : null;
}

// A page the user visited shows a main text box. The shortest address of the
// site that does is kept.
export async function learnTextBox(pageUrl) {
  const start = startOf(pageUrl);
  if (!start) return;
  const site = hostOf(pageUrl);
  writing = writing.then(async () => {
    const { textBoxes = {} } = await chrome.storage.local.get('textBoxes');
    if (textBoxes[site] && textBoxes[site].length <= start.length) return;
    await chrome.storage.local.set({ textBoxes: Object.fromEntries(Object.entries({ ...textBoxes, [site]: start }).slice(-MAX_SITES)) });
  }).catch(() => {});
  await writing;
}

// The texts on their way to a page, by tab.
const onTheWay = new Map();

// Opens the site's page for a text to be typed into, in the tab given or a
// new one. Only a site the user allowed is typed into.
export async function typeInto({ site, text, tabId, windowId }) {
  const { textBoxes = {}, typeAllowed = {} } = await chrome.storage.local.get(['textBoxes', 'typeAllowed']);
  const url = textBoxes[site];
  if (!url || typeAllowed[site] !== true || typeof text !== 'string' || !await chrome.permissions.contains(PAGES)) return;
  const tab = tabId === undefined ? await chrome.tabs.create({ windowId, url }) : await chrome.tabs.update(tabId, { url });
  onTheWay.set(tab.id, { site, text, until: Date.now() + ARRIVE_MS });
}

// The page is typed into once it has loaded, and only while the tab is on the
// site: one that leads elsewhere first, to sign in, is waited for.
export async function pageLoaded(tabId, url) {
  const pending = onTheWay.get(tabId);
  if (!pending) return;
  if (Date.now() > pending.until) {
    onTheWay.delete(tabId);
    return;
  }
  if (!/^https?:/.test(url ?? '') || hostOf(url) !== pending.site) return;
  onTheWay.delete(tabId);
  const icon = async (name) => `data:image/svg+xml;base64,${btoa(await (await fetch(chrome.runtime.getURL(`src/${name}`))).text())}`;
  const args = [pending.text, BOX_MS, await icon('copy.svg'), await icon('text-cursor-input.svg')];
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/text-box.js', 'src/type-into.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, func: (...values) => globalThis.oneSearchTypeInto(...values), args });
}

export function tabGone(tabId) {
  onTheWay.delete(tabId);
}
