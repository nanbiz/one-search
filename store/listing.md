# Chrome Web Store listing

Fields as the developer dashboard asks for them. The package is the release zip
(`node scripts/package.js` builds the same file).

## Store listing

- Name and summary come from manifest.json.
- Category: Tools
- Language: English
- Store icon: icons/icon-128.png
- Screenshots: store/screenshot-1.png, store/screenshot-2.png, store/screenshot-3.png
- Small promo tile: store/promo-small-440x280.png, made with the icon by icons/build.sh
- Homepage: https://github.com/nanbiz/one-search
- Support: https://github.com/nanbiz/one-search/issues

Description:

Spotlight-like search for your browser. Press Ctrl+T and a search bar opens over the page you are on. No tab opens until you pick something.

Find anything from one place. Type part of a title to switch to a tab in any window, type an address or a search to open it, or search your history and bookmarks once you allow it. Pick a site with its own search and press Tab to search it directly. Browser pages such as downloads or settings and actions such as duplicate, pin tab or private window are found by name.

Every tab, one key. Hold Alt to see all tabs of the window, each with a key to jump to it. The arrow keys work too, starting at the current tab.

New tabs without the clutter. The + button's new tab becomes the search as well, and Escape takes you back to where you were.

Clear the rest. The toolbar button closes the window's other tabs and shows how many. Pinned tabs and tab groups stay.

It opens with Ctrl+Shift+Space, and on Ctrl+T after a short guided setup in browsers that allow it. In Vivaldi, which keeps Ctrl+T, its new tab becomes the search instead.

Formerly Zen Essentials in Chrome: pinned tabs are no longer shared between windows and work as your browser handles them.

On request we'll extend to Firefox: https://github.com/nanbiz/one-search/issues

Nothing is collected or sent anywhere. Source: https://github.com/nanbiz/one-search

## Privacy practices

- Single purpose: One search bar, opened instead of a new tab, to open, find and manage tabs.
- tabs: Reads the address, title and icon of the user's open tabs to list and suggest them while the search is open, and to count and close tabs for the toolbar button.
- storage: Keeps settings, the search addresses of sites, how long recent openings took and, for the session, unfinished text and a copy of history and bookmarks the user allowed.
- favicon: Shows the icons of suggested sites from the browser's own favicon store.
- alarms: Keeps the extension's worker running so the search opens without a delay.
- contextMenus: Adds an on/off entry to the toolbar button's right-click menu.
- activeTab: Lets the search be drawn over the page the user is on, only after the user presses its keyboard shortcut there.
- scripting: Inserts the search into the page the user is on when the user presses its keyboard shortcut; nothing is read from the page. Where the user allowed all sites, also reads the site's OpenSearch description so the site can be searched.
- search: Sends a search the user picks in the search to the browser's default search engine.
- history (optional, asked for from the search): Lets the search suggest sites and pages the user visited for what they type, once the user allows it; held in session storage, never sent.
- bookmarks (optional, asked for from the search): Lets the search suggest the user's bookmarks for what they type, once the user allows it; held in session storage, never sent.
- Host permission <all_urls> (optional, asked for from the search): Lets a tab opened on the New Tab page close at once and the search open over the page the user was on instead, once the user allows it; on pages visited it also reads the site's OpenSearch description, so that site can be searched with Tab; nothing else is read.
- Remote code: No.
- Data usage: no data collected; certify the three statements (not sold, not used for unrelated purposes, not used for creditworthiness).
- Privacy policy: https://github.com/nanbiz/one-search/blob/main/PRIVACY.md
