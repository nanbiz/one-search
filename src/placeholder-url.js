// Whether a tab shows the address, ignoring the fragment.
export function isOpen(tabs, url) {
  const plain = (address) => (address ?? '').split('#')[0];
  return Boolean(url) && tabs.some((tab) => plain(tab.pendingUrl || tab.url) === plain(url));
}
