// Runs on the pages the user visits while the extension may draw on pages,
// and passes on a site's OpenSearch description, where a site declares its
// own search, so Tab in the overlay can search that site. A description on
// the page's own origin is read here, with the page's session, where the
// worker still has to learn the site.
(async () => {
  const link = document.querySelector('link[rel="search"][type="application/opensearchdescription+xml"][href]');
  if (!link) return;
  const read = await chrome.runtime.sendMessage({ type: 'openSearch', href: link.href }).catch(() => null);
  if (read !== 'page') return;
  const text = await fetch(link.href, { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.text() : ''), () => '');
  chrome.runtime.sendMessage({ type: 'openSearchText', text }).catch(() => {});
})();

// Says that the page has a main text box, which Tab in the overlay can type
// into. An application shows its box some time after its page has loaded.
(async () => {
  for (let attempt = 0; attempt < 12 && document.visibilityState !== 'hidden'; attempt++) {
    if (globalThis.oneSearchTextBox()) {
      chrome.runtime.sendMessage({ type: 'textBox' }).catch(() => {});
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
})();
