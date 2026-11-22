// Writes src/site-search.json: for each site with a search of its own, the
// address that searches it, with {{{s}}} where the search goes. It is derived
// from DuckDuckGo's list of bangs (https://duckduckgo.com/bang.js), keeping
// only bangs that search the site they belong to, the one ranked highest per
// site.
//
// Usage: node scripts/site-search.js <bang.js file>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const host = (name) => name.toLowerCase().replace(/^www\./, '');
const best = new Map();
for (const bang of JSON.parse(readFileSync(process.argv[2], 'utf8'))) {
  const site = host(bang.d ?? '');
  if (!site || !bang.u?.includes('{{{s}}}')) continue;
  let searched;
  try {
    searched = host(new URL(bang.u.replaceAll('{{{s}}}', 'x')).hostname);
  } catch {
    continue;
  }
  const sameSite = searched === site || searched.endsWith(`.${site}`) || site.endsWith(`.${searched}`);
  // A search on a local network, a router's say, is no site to search.
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(searched) || /\b(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/.test(bang.u);
  if (!sameSite || local) continue;
  const rank = bang.r ?? 0;
  if (!best.has(site) || rank > best.get(site).rank) best.set(site, { rank, url: bang.u });
}
const sites = Object.fromEntries([...best].sort(([a], [b]) => a.localeCompare(b)).map(([site, { url }]) => [site, url]));
writeFileSync(join(root, 'src', 'site-search.json'), `${JSON.stringify(sites)}\n`);
console.log(`${Object.keys(sites).length} sites`);
