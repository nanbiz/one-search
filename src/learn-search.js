// Runs on the pages the user visits while the extension may draw on pages,
// and passes on a site's OpenSearch description, where a site declares its
// own search, so Tab in the overlay can search that site.
(() => {
  const link = document.querySelector('link[rel="search"][type="application/opensearchdescription+xml"][href]');
  if (link) chrome.runtime.sendMessage({ type: 'openSearch', href: link.href }).catch(() => {});
})();
