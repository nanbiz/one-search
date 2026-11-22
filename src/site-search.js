// The worker's side of searching one site from the overlay: the searches it
// learns from the OpenSearch descriptions of the sites visited, kept beside
// the list shipped with the extension.

const PAGES = { origins: ['<all_urls>'] };
const SCRIPT = { id: 'learn-search', js: ['src/learn-search.js'], matches: ['http://*/*', 'https://*/*'], runAt: 'document_idle' };
// Sites learned, at most this many, the oldest going first; a site whose
// description gives no search of its own is kept as an empty address, so it
// is not read again.
const MAX_LEARNED = 2000;
// A description is a few kilobytes; more is not read.
const MAX_DESCRIPTION = 100_000;
// Each site's description is read once a session.
const tried = new Set();
// Learned sites are written one after another, so two learned at once both
// stay.
let writing = Promise.resolve();
let shipped = null;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// The page script runs while the user lets the extension draw on pages.
export async function keepLearningSearch() {
  const allowed = await chrome.permissions.contains(PAGES).catch(() => false);
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT.id] })).length > 0;
  if (allowed && !registered) await chrome.scripting.registerContentScripts([SCRIPT]);
  if (!allowed && registered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT.id] });
}

function sameSite(host, site) {
  return host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`);
}

// The template with {{{s}}} for {searchTerms} and its optional parameters,
// written {name?}, left out; null for an address that is not on the web.
function withoutOptional(template) {
  const marker = 'synced-pins-search-terms';
  let url;
  try {
    url = new URL(template.replaceAll('{searchTerms}', marker));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  for (const [name, value] of [...url.searchParams]) {
    if (/^\{[^}]*\?\}$/.test(value)) url.searchParams.delete(name);
  }
  const address = url.toString().replaceAll(marker, '{{{s}}}');
  return address.includes('{{{s}}}') ? address : null;
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[2] ?? match[3]) : null;
}

function decode(text) {
  return text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

// The address that searches the site, from its description's Url of type
// text/html, with {{{s}}} for {searchTerms} and its optional parameters left
// out; none where it searches another site.
export function searchAddressFrom(description, site) {
  for (const [tag] of description.matchAll(/<Url\b[^>]*>/gi)) {
    if ((attribute(tag, 'type') ?? '').toLowerCase() !== 'text/html') continue;
    const template = attribute(tag, 'template');
    if (!template?.includes('{searchTerms}')) continue;
    const address = withoutOptional(decode(template));
    if (!address) continue;
    if (sameSite(hostOf(address.replaceAll('{{{s}}}', 'x')), site)) return address;
  }
  return null;
}

export async function learnSearch(pageUrl, href) {
  const site = hostOf(pageUrl);
  if (!site || tried.has(site)) return;
  tried.add(site);
  // Only the site's own description is read, so a page cannot have the
  // extension request an address of its choosing, one on the local network
  // say.
  let description;
  try {
    description = new URL(href);
  } catch {
    return;
  }
  if (!/^https?:$/.test(description.protocol) || !sameSite(hostOf(description.href), site)) return;
  shipped ??= await fetch(chrome.runtime.getURL('src/site-search.json')).then((response) => response.json()).catch(() => ({}));
  if (shipped[site]) return;
  const { learnedSearch = {} } = await chrome.storage.local.get('learnedSearch');
  if (site in learnedSearch) return;
  const text = await fetch(description, { credentials: 'omit' })
    .then((response) => (response.ok ? response.text() : ''), () => '');
  const address = text.length <= MAX_DESCRIPTION ? searchAddressFrom(text, site) : null;
  writing = writing.then(async () => {
    const { learnedSearch: now = {} } = await chrome.storage.local.get('learnedSearch');
    const sites = Object.entries({ ...now, [site]: address ?? '' }).slice(-MAX_LEARNED);
    await chrome.storage.local.set({ learnedSearch: Object.fromEntries(sites) });
  }).catch(() => {});
  await writing;
}
