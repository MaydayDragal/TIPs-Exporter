// Toolbar button: toggle the exporter panel on the TIPS Reader tab.
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
    // Tab was open before the extension was installed/reloaded: inject, then toggle.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  }
});
