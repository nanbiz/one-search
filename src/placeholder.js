import { isOpen } from './placeholder-url.js';

// A tab that stood in for a pinned page in versions that shared pins across
// windows, brought back by the browser. It opens its page, or goes where the
// page is open already. One at a time, so two of them do not both open it.
const url = new URLSearchParams(location.search).get('url');
navigator.locks.request('synced-pins-placeholder', async () => {
  const self = await chrome.tabs.getCurrent();
  const others = (await chrome.tabs.query({})).filter((tab) => tab.id !== self.id);
  const alone = !others.some((tab) => tab.windowId === self.windowId);
  if (url && (alone || !isOpen(others, url))) await chrome.tabs.update(self.id, { url });
  else await chrome.tabs.remove(self.id);
});
