/* One browser-wide alarm; authenticated requests and downloads stay in a TIPS tab. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TIPSLibraryPolling = api;
})(globalThis, () => {
  const ALARM = 'tips-library-sync', READER = 'https://xentry.mercedes-benz.com/tips-reader/';
  const minutes = value => Number.isInteger(value) && value >= 1 && value <= 1440 ? value : 10;
  function create({ chrome, db, now = Date.now }) {
    let configuration = Promise.resolve(), dispatching = false;
    const enabled = s => !!(s?.configured && s.auto);
    function reconcile(reset = false) {
      const next = configuration.then(async () => {
        const { documentsFolder: s } = await chrome.storage.local.get(['documentsFolder']);
        const alarm = await chrome.alarms.get(ALARM);
        if (!enabled(s)) { if (alarm) await chrome.alarms.clear(ALARM); return; }
        const period = minutes(s.pollMinutes);
        if (!alarm || alarm.periodInMinutes !== period || reset) await chrome.alarms.create(ALARM, { delayInMinutes: period, periodInMinutes: period });
      });
      configuration = next.catch(e => console.warn('TIPS Exporter: sync schedule', e.message));
      return next;
    }
    async function message(id, value) {
      let timeout;
      try { return await Promise.race([chrome.tabs.sendMessage(id, value), new Promise(resolve => { timeout = setTimeout(() => resolve(null), 2500); })]); }
      catch (_) { return null; }
      finally { clearTimeout(timeout); }
    }
    // Each scheduled check records what happened, so a TIPS tab can say why automatic sync is overdue.
    const note = async outcome => { try { await chrome.storage.local.set({ pollLast: { at: new Date(now()).toISOString(), outcome } }); } catch (_) {} };
    async function tick() {
      if (dispatching) return;
      dispatching = true;
      try {
        const { documentsFolder: s, lastCheck } = await chrome.storage.local.get(['documentsFolder', 'lastCheck']);
        if (!enabled(s) || now() - Date.parse(lastCheck?.at) < minutes(s.pollMinutes) * 60000 - 1000) return;
        const connection = await db.get('documentsConnection');
        if (!connection || await connection.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') { await note('no-access'); return 'no-access'; }   // the startup caller then runs its own sync, which reports the missing permission
        const all = (await chrome.tabs.query({ url: READER + '*' })).filter(t => Number.isInteger(t.id) && t.url?.startsWith(READER));
        if (!all.length) { await note('no-tab'); return; }
        // Chrome freezes or discards background tabs to save energy/memory; such a tab cannot run a sync.
        // It catches up itself as soon as it is shown again.
        const tabs = all.filter(t => !t.discarded && !t.frozen);
        const states = await Promise.all(tabs.map(async tab => ({ tab, state: await message(tab.id, { type: 'library-poll-status' }) })));
        // A manual export, scan or another automatic update gets the whole interval to finish.
        if (states.some(x => x.state?.busy)) { await note('busy'); return; }
        const current = (await chrome.storage.local.get(['documentsFolder'])).documentsFolder;
        if (!enabled(current) || current.epoch !== s.epoch) return;
        const candidate = states.filter(x => x.state?.ready).sort((a,b) => Number(!!b.tab.active) - Number(!!a.tab.active) || a.tab.id - b.tab.id)[0];
        if (!candidate) { await note(states.some(x => x.state) ? 'not-ready' : 'asleep'); return; }
        // A decline can mean manual work started after the status check. A missing
        // reply can mean the check started before its channel closed. In either
        // case, wait for the next interval instead of dispatching to another tab.
        const reply = await message(candidate.tab.id, { type: 'library-poll' });
        await note(reply?.accepted ? 'dispatched' : 'declined');
      } finally { dispatching = false; }
    }
    function start() {
      const run = () => tick().catch(e => console.warn('TIPS Exporter: scheduled sync', e.message));
      chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) return run(); });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes.documentsFolder || changes.lastCheck)) return reconcile(!!changes.lastCheck).catch(() => {});
      });
      chrome.runtime.onStartup.addListener(() => reconcile().catch(() => {}));
      chrome.runtime.onInstalled.addListener(() => reconcile().catch(() => {}));
      chrome.runtime.onMessage.addListener((m, sender, reply) => {
        if (m?.type !== 'library-poll-startup') return;
        if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith(READER) || !Number.isInteger(sender.tab?.id)) { reply({ handled: true, error: 'Request not allowed.' }); return; }
        run().then(r => reply({ handled: r !== 'no-access' })); return true;
      });
      reconcile().catch(() => {});
    }
    return { reconcile, tick, start };
  }
  return { create };
});
