/* Folder-index service. Loaded by the extension service worker, not by XENTRY. */
(() => {
  const db = TIPSFolderDB;
  const repo = TIPSIndexFolder.create({
    readRecord: async () => await db.get('connection') || null,
    writeRecord: r => r ? db.put('connection', r) : db.del('connection'),
    readState: async () => { const s = await chrome.storage.local.get(['index', 'done']); return { index: s.index || [], done: s.done || {} }; },
    writeState: (s, options = {}) => chrome.storage.local.set({ index: s.index, done: s.done,
      ...(options.reset ? { history: [], retry: {}, lastCheck: null, latest: {} } : {}) }),
    writeStatus: s => chrome.storage.local.set({ indexFolder: s })
  });
  // A source switch must not take place underneath a running/prepared/interrupted export.
  // Every tab message is bounded: a frozen or hung TIPS tab never answers, and an unanswered
  // tabs.sendMessage would keep this request open until Chrome stops the worker. That closed the
  // caller's message channel and left the asking tab locked (Folder settings grayed out) for good.
  const LOCK_REPLY_MS = globalThis.TIPSLockReplyMs || 10000;   // well under the 30 s idle limit after which Chrome stops the worker
  async function ask(id, message) {
    let timeout;
    try { return await Promise.race([chrome.tabs.sendMessage(id, message), new Promise(resolve => { timeout = setTimeout(() => resolve({ timedOut: true }), LOCK_REPLY_MS); })]); }
    finally { clearTimeout(timeout); }
  }
  async function withIdleTabs(fn, label = 'index folder') {
    const asked = [], token = crypto.randomUUID();
    try {
      const tabs = await chrome.tabs.query({ url: 'https://xentry.mercedes-benz.com/tips-reader/*' });
      for (const tab of tabs) {
        let result;
        try { result = await ask(tab.id, { type: 'index-folder-lock', token }); }
        catch (_) { continue; } // tab has no exporter content script yet
        asked.push(tab.id);
        // Silence is not an idle answer: a frozen tab can still hold a prepared ZIP or an interrupted
        // export. Refuse with a clear reason instead of hanging; its late lock is released below.
        if (result?.timedOut) throw Error(`A TIPS tab is not responding (Chrome may have put it to sleep in the background). Switch to each TIPS tab or close the extra ones, then try the ${label} again.`);
        if (!result || result.locked !== true) throw Error(`Finish or discard the current export/check before changing or reloading the ${label}. Reload older TIPS tabs after updating the extension.`);
      }
      return await fn();
    } finally {
      // Unlock every tab that was asked, including one whose lock reply was late. An unlock with
      // another token is ignored by the tab, so this never releases someone else's lock.
      await Promise.allSettled(asked.map(id => ask(id, { type: 'index-folder-unlock', token })));
    }
  }
  globalThis.TIPSWithIdleTabs = withIdleTabs;
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || m.type !== 'index-folder') return;
    const own = sender?.id === chrome.runtime.id;
    const options = own && [chrome.runtime.getURL('folder-settings.html'), chrome.runtime.getURL('grant.html')].includes(sender.url);
    const reader = own && /^https:\/\/xentry\.mercedes-benz\.com\/tips-reader\//.test(sender.url || '');
    if (!options && !reader) { reply({ ok: false, error: 'This index request is not allowed.' }); return; }
    (async () => {
      if (m.action === 'open') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
      // Folder access must be renewed by a click on an extension page: open a small window for that one click.
      if (m.action === 'grant') { await chrome.windows.create({ url: chrome.runtime.getURL('grant.html'), type: 'popup', width: 480, height: 400, focused: true }); return { ok: true }; }
      if (m.action === 'status') return { ok: true, status: (await chrome.storage.local.get('indexFolder')).indexFolder || await repo.status() };
      if (m.action === 'load') return withIdleTabs(() => repo.load());
      if (m.action === 'save' && reader) return repo.save(m.snapshot, m.epoch, m.base);
      if (!options) throw Error('Change the folder through the extension Settings page.');
      if (m.action === 'connect') {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(m.token || '')) throw Error('Choose a folder first.');
        const key = 'candidate:' + m.token;
        try {
          return await withIdleTabs(async () => {
            const c = await db.get(key); if (!c?.handle) throw Error('Choose a folder first.');
            return repo.connect(c.handle, c.filename);
          });
        } finally { await db.del(key); }
      }
      if (m.action === 'reload') return withIdleTabs(async () => {
        const r = await db.get('connection'); if (!r) throw Error('Choose an index folder first.');
        // Explicit Settings action: the user has chosen the disk copy to resolve a conflict.
        return repo.connect(r.handle, r.filename);
      });
      if (m.action === 'disconnect') return withIdleTabs(() => repo.disconnect());
      throw Error('Unknown index folder action.');
    })().then(reply, e => reply({ ok: false, error: e.message || String(e) }));
    return true;
  });
})();
