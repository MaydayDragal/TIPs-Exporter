importScripts('index-csv.js', 'index-folder.js', 'folder-db.js', 'index-background.js', 'documents-client.js', 'documents-folder.js', 'documents-background.js');

// Toolbar icon: open/close the exporter drawer on the TIPS Reader tab.
const READER = 'https://xentry.mercedes-benz.com/tips-reader/';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.startsWith(READER)) {
    // Not on the Reader: open it.
    chrome.tabs.create({ url: READER + 'search/topics' });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch (e) {
    // Tab was open before the extension was installed/updated, so it has no exporter yet:
    // reload it and open the drawer once it is back (content.js reads this flag on load).
    await chrome.storage.local.set({ openOnLoad: Date.now() });
    chrome.tabs.reload(tab.id);
  }
});
