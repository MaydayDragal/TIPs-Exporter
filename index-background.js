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
  async function withIdleTabs(fn) {
    const locked = [], token = crypto.randomUUID();
    try {
      const tabs = await chrome.tabs.query({ url: 'https://xentry.mercedes-benz.com/tips-reader/*' });
      for (const tab of tabs) {
        let result;
        try { result = await chrome.tabs.sendMessage(tab.id, { type: 'index-folder-lock', token }); }
        catch (_) { continue; } // tab has no exporter content script yet
        if (!result || result.locked !== true) throw Error('Finish or discard the current export/check before changing or reloading the index folder. Reload older TIPS tabs after updating the extension.');
        locked.push(tab.id);
      }
      return await fn();
    } finally {
      await Promise.allSettled(locked.map(id => chrome.tabs.sendMessage(id, { type: 'index-folder-unlock', token })));
    }
  }
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || m.type !== 'index-folder') return;
    const own = sender?.id === chrome.runtime.id;
    const options = own && sender.url === chrome.runtime.getURL('folder-settings.html');
    const reader = own && /^https:\/\/xentry\.mercedes-benz\.com\/tips-reader\//.test(sender.url || '');
    if (!options && !reader) { reply({ ok: false, error: 'This index request is not allowed.' }); return; }
    (async () => {
      if (m.action === 'open') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
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
