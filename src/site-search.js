// The worker's side of searching one site from the overlay: the searches it
// learns from the OpenSearch descriptions of the sites visited, kept beside
// the list shipped with the extension.

const PAGES = { origins: ['<all_urls>'] };
const SCRIPT = { id: 'learn-search', js: ['src/learn-search.js'], matches: ['http://*/*', 'https://*/*'], runAt: 'document_idle' };
// Sites learned, at most this many, the oldest going first.
const MAX_LEARNED = 2000;
// Each site's description is read once a session.
const tried = new Set();

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
    const address = decode(template).replaceAll('{searchTerms}', '{{{s}}}').replace(/[?&][^=&]+=\{[^}]*\?\}/g, '');
    const host = hostOf(address.replaceAll('{{{s}}}', 'x'));
    if (/^https?:/.test(address) && (host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`))) return address;
  }
  return null;
}

export async function learnSearch(pageUrl, href) {
  const site = hostOf(pageUrl);
  if (!site || tried.has(site)) return;
  tried.add(site);
  const { learnedSearch = {} } = await chrome.storage.local.get('learnedSearch');
  if (learnedSearch[site]) return;
  const description = await fetch(href, { credentials: 'omit' }).then((response) => (response.ok ? response.text() : ''), () => '');
  const address = searchAddressFrom(description, site);
  if (!address) return;
  const sites = Object.entries({ ...learnedSearch, [site]: address }).slice(-MAX_LEARNED);
  await chrome.storage.local.set({ learnedSearch: Object.fromEntries(sites) });
}
