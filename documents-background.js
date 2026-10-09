/* Native archive access stays in the extension worker; TIPS supplies authenticated file bytes. */
(() => {
  const db = TIPSFolderDB;
  const repo = TIPSDocumentsFolder.create({ db, writeStatus: s => chrome.storage.local.set({ documentsFolder: s }) });
  async function recover() {
    const run = await repo.active(); if (!run) return;
    let response;
    try { response = await chrome.tabs.sendMessage(run.owner, { type: 'documents-folder-active', token: run.token }); }
    catch (_) { /* Closed/reloaded tab or removed content script. */ }
    if (response?.active === false || !response) await repo.abandon();
  }
  const change = fn => TIPSWithIdleTabs(async () => { await recover(); return { ok: true, status: await fn() }; }, 'documents folder');
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (m?.type !== 'documents-folder') return;
    const own = sender?.id === chrome.runtime.id;
    const options = own && sender.url === chrome.runtime.getURL('folder-settings.html');
    const reader = own && /^https:\/\/xentry\.mercedes-benz\.com\/tips-reader\//.test(sender.url || '') && Number.isInteger(sender.tab?.id);
    if (!options && !reader) { reply({ ok: false, error: 'This documents folder request is not allowed.' }); return; }
    (async () => {
      if (m.action === 'open') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
      if (m.action === 'status') return { ok: true, status: await repo.status() };
      if (m.action === 'set-auto') return { ok: true, status: await repo.setAuto(m.auto) };
      if (m.action === 'inventory') {
        const snapshot = reader ? m.snapshot : await chrome.storage.local.get(['index', 'done']);
        return { ok: true, inventory: await repo.inventory(snapshot) };
      }
      if (['connect', 'configure', 'disconnect'].includes(m.action)) {
        if (!options) throw Error('Change the documents folder through extension Settings.');
        if (m.action === 'configure') return change(() => repo.configure(m.options || {}));
        if (m.action === 'disconnect') return change(() => repo.disconnect());
        if (!/^[\w-]{1,80}$/.test(m.token || '')) throw Error('Choose a documents folder first.');
        const key = 'documents-candidate:' + m.token;
        try {
          return await change(async () => { const c = await db.get(key); if (!c?.handle) throw Error('Choose a documents folder first.'); return repo.connect(c.handle, m.options || {}); });
        } finally { await db.del(key); }
      }
      if (!reader) throw Error('Open TIPS Reader to update saved documents.');
      const owner = sender.tab.id, token = m.token;
      if (m.action === 'ack-exceptions') return { ok: true, ...await repo.ackExceptions(m.ids) };
      if (m.action === 'observe-index') return { ok: true, ...await repo.observeIndex(m.snapshot) };
      if (m.action === 'start') { await recover(); return { ok: true, ...await repo.start(token, owner, m.snapshot, m.options) }; }
      if (m.action === 'begin') return { ok: true, ...await repo.begin(token, owner, m.file) };
      if (m.action === 'chunk') return { ok: true, ...await repo.chunk(token, owner, m.upload, m.offset, m.data) };
      if (m.action === 'finish') return { ok: true, ...await repo.finish(token, owner, m.upload) };
      if (m.action === 'topic-start') return { ok: true, ...await repo.topicStart(token, owner, m.tips) };
      if (m.action === 'topic-done') return { ok: true, ...await repo.topicDone(token, owner, m.result) };
      if (m.action === 'end') return { ok: true, status: await repo.end(token, owner, m.summary) };
      throw Error('Unknown documents folder action.');
    })().then(reply, e => reply({ ok: false, error: e.message || String(e) }));
    return true;
  });
})();
