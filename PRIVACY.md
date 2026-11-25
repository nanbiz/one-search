# Privacy

One Search To Rule Them All does not collect, send or share any data about you. Everything below stays in your browser.

While the search is open, it reads the address, title and icon of your open tabs to list and suggest them, and loads the icons of the sites it shows, as the browser does for its tabs. A search you pick goes to your browser's default search engine, or to the site you chose to search. An address you pick opens as if you had typed it.

Text you typed and left without choosing anything stays in the browser's session storage, and comes back if you open the search over the same tab within 45 seconds. Session storage is cleared when the browser quits.

The search is drawn over a page after you press its shortcut or its toolbar button there, or over the page you were on when you open a new tab, if you allow that. On a page too busy to draw it, it opens as a tab over a picture of that page, which is held in session storage until shown. On a page it cannot be drawn over, it notes that page's address and the reason in session storage.

If you allow it to open over any page, it also looks on the pages you visit for the site's own search description (OpenSearch), so you can search that site with Tab. It requests that description from the site itself, with your session there only where the description is on the same address as the page, and keeps the site's name and search address in local storage. It also notes the address of pages that show a text box, without reading what is in it, so you can type into that box from the search: the site's name and that address are kept in local storage. A text is typed only into the site you picked it for, and only that text, which is then sent the way the page sends it. The page's box is checked to be empty first. It reads nothing else from pages.

If you allow history and bookmarks, it searches them for what you type. A copy of their addresses, titles and visit counts is held in session storage so the search opens at once.

For the last 20 times it opened over a page, it keeps that page's site name and how long each step took in local storage, so a slow opening can be looked into.

**Close other tabs** in the toolbar button's right-click menu closes the other tabs of its window.

Versions up to 1.1.14 also kept the address, title and icon of your pinned tabs in local storage, and a log of decisions about them, to show them in every window. Later versions delete both.

Removing the extension removes all of this. Questions go to the [issue tracker](https://github.com/nanbiz/one-search/issues).
