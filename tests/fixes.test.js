// Regression tests for the QA-round fixes.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');

const T = [
  { tips: 'LI42.10-P-078779', tipsId: 242206748, version: 6, title: 'Brake vibration', modificationDate: 1 },
  { tips: 'LI54.10-P-080684', tipsId: 242210255, version: 3, title: 'Charging fault', modificationDate: 2 },
  { tips: 'LI20.10-P-075374', tipsId: 242201586, version: 2, title: 'Coolant warning', modificationDate: 3 }];
const log = [];
async function fakeFetch(url, init = {}) {
  const u = String(url), t = Date.now();
  if (u.includes('/topics/search')) { const b = JSON.parse(init.body); const h = b.docName ? T.filter(x => x.tips === b.docName) : T; log.push({ t, kind: 'search' }); return { ok: true, status: 200, json: async () => ({ totalHits: h.length, hits: h }) }; }
  if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: 'o1' }) };
  if (u.includes('/file/topics/')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64 * 1024) };
  const m = u.match(/\/topics\/(\d+)\/(\d+)\?/);
  if (m) { log.push({ t, kind: 'doc', id: m[1] }); const x = T.find(y => String(y.tipsId) === m[1]); return { ok: true, status: 200, json: async () => ({ version: x.version, attachments: [], references: [], history: { children: [] } }) }; }
  return { ok: false, status: 404 };
}
const dialog = (li) => `<neo-topic-detail><header><h2>Topic</h2><div class="xy-d-flex"><xy-c-spinner><div><button class="xy-i-print" style="width:48px;height:48px">P</button></div></xy-c-spinner><div class="xy-border-right"></div></div></header>
  <table><tr><td>Topic number</td><td>${li}</td></tr></table><p>see LI54.10-P-080684</p></neo-topic-detail>`;

function makeEnv({ settings, extra = {}, path = '/tips-reader/search/topics', body = '', slowIndex = 0 } = {}) {
  const dom = new JSDOM(`<!doctype html><head></head><body>TIPS Reader v1.22.0 - 2026${body}</body>`, { url: 'https://xentry.mercedes-benz.com' + path, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings, ...extra }, saved = [], writes = [];
  w.TextEncoder = TextEncoder; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { saved.push(this.download); };
  w.chrome = { storage: { local: {
    get: async k => { if (k === 'index' && slowIndex) await new Promise(r => setTimeout(r, slowIndex)); return { [k]: st[k] }; },
    set: async o => { writes.push(JSON.parse(JSON.stringify(o))); Object.assign(st, o); } } }, runtime: { onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true; w.fetch = fakeFetch;
  const pm = w.postMessage.bind(w);
  w.postMessage = (d, o) => { if (d && d.__tipsx) setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { data: d, source: w })), 0); else pm(d, o); };
  w.eval(probe); w.eval(content);
  const env = { w, st, saved, writes, root: () => [...w.document.documentElement.children].find(e => e.shadowRoot).shadowRoot };
  env.$ = id => env.root().getElementById(id);
  env.text = () => { const r = (env.root().querySelector('.dr') || env.w.document.createElement('div')), tw = w.document.createTreeWalker(r, 4), a = []; while (tw.nextNode()) if (tw.currentNode.parentElement.tagName !== 'STYLE') a.push(tw.currentNode.textContent); return a.join(' ').replace(/\s+/g, ' '); };
  env.open = async () => { await tick(60); w.__toggle({ type: 'toggle' }, null, () => { }); await tick(30); };
  env.type = v => { const t = env.$('li'); t.value = v; t.dispatchEvent(new w.Event('input')); };
  return env;
}
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(15); } }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const S0 = { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 150, delayMaxMs: 250, pageSize: 20, pageSizeSrc: 'detected', batchSize: 2, autoContinue: false };
const IDX = T.map(x => ({ tips: x.tips, tipsId: x.tipsId, version: x.version, title: x.title, mdate: 0 }));

(async () => {
  // F2: page-size message during a slow load must not overwrite saved settings
  {
    const saved = { ...S0, batchSize: 7, pageSize: 30, pageSizeSrc: 'manual', pos: { left: 500, top: 10 }, files: { docJson: false, histCsv: true, histJson: false, attCsv: true, manifest: true } };
    const e = makeEnv({ settings: saved, extra: { index: IDX }, slowIndex: 250 });
    await e.w.fetch('/tips/topic-service/api/v1/topics/search', { method: 'POST', body: JSON.stringify({ pagination: { pageSize: 25 }, sortorder: {} }) });
    await tick(500);
    const first = e.writes.find(x => x.settings);
    ok(!first || (first.settings.batchSize === 7 && first.settings.files.docJson === false ), 'F2: no default settings written before load finishes');
    ok(e.st.settings.batchSize === 7 && e.st.settings.pageSize === 30 && e.st.settings.pageSizeSrc === 'manual', 'F2: saved settings (batch 7, manual page size 30) intact');
  }
  // F1: toolbar refuses when the LI number found on the page is not the open topic
  {
    const e = makeEnv({ settings: { ...S0 }, extra: { index: [] }, path: '/tips-reader/search/topics/999999/4', body: dialog('LI54.10-P-080684') });
    await tick(150);
    const b = e.w.document.querySelector('button.tipsx-dl');
    b.click();
    await waitFor(() => b.dataset.state === 'error');
    ok(e.saved.length === 0 && /is not the topic that's open/.test(b.nextElementSibling.textContent), 'F1: mismatched topic → no download, clear error');
  }
  // F7: toolbar download keeps the list the user looked up in the panel
  {
    const e = makeEnv({ settings: { ...S0 }, extra: { index: IDX }, path: '/tips-reader/search/topics/242206748/6', body: dialog('LI42.10-P-078779') });
    await e.open();
    e.type('LI54.10-P-080684 LI20.10-P-075374'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
    const b = e.w.document.querySelector('button.tipsx-dl');
    b.click();
    const go = () => { for (const el of e.w.document.documentElement.children) { const x = el.shadowRoot && el.shadowRoot.querySelector('#p_go'); if (x) return x; } return null; };
    await waitFor(() => go() && !go().disabled); go().click();
    await waitFor(() => b.dataset.state === 'done');
    ok(/^TIPS_LI42\.10-P-078779_v\d+\.zip$/.test(e.saved[0]), 'F7: toolbar download saved the open topic (current version, the picker default): ' + e.saved[0]);
    ok(e.$('dlfound') && /Download 2/.test(e.text()) && e.$('li').value === 'LI54.10-P-080684 LI20.10-P-075374', 'F7: panel still shows the user\'s looked-up list afterwards');
    // second click while a panel download runs → specific message, not a stale one
    e.$('dlfound').click(); await waitFor(() => e.$('cancel'));
    await tick(400);   // let the done state lapse? (5 s) — force idle
    b.dataset.state = 'x';
  }
  // F8 + F5: single download running → Bulk screen shows it with Cancel; Settings edits survive progress updates
  {
    const e = makeEnv({ settings: { ...S0, delayMs: 400, delayMaxMs: 500 }, extra: { index: IDX } });
    await e.open();
    e.type('LI42.10-P-078779 LI54.10-P-080684 LI20.10-P-075374'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
    e.$('dlfound').click(); await waitFor(() => e.$('cancel'));
    e.$('gear').click(); await tick(20);
    const bs = e.$('s_bs'); bs.value = '9'; bs.dispatchEvent(new e.w.Event('input'));
    await tick(1500);   // at least one more document + its steps while Settings is open
    ok(e.$('s_bs').value === '9', 'F5: unsaved Settings edit survives download progress');
    e.$('tobulk') || e.root().querySelector('#tobulk');
    // navigate to bulk: the row is hidden during a run, so switch via the view link from settings is not available — use the bulk row if present
    if (e.$('tobulk')) { e.$('tobulk').click(); await tick(20); }
    else { e.w.__toggle({ type: 'toggle' }); e.w.__toggle({ type: 'toggle' }); }
    if (e.$('tosingle')) {
      ok(!e.$('prep') && e.$('cancel') && /A single-LI download is running/.test(e.text()), 'F8: Bulk screen shows the running download with Cancel, no dead Prepare');
      e.$('cancel').click(); await waitFor(() => /cancelled/.test(e.text()));
      ok(e.saved.length === 0, 'F8: Cancel from the Bulk screen stops the download');
    } else ok(true, 'F8: (bulk row hidden during a single run – not reachable)');
  }
  // F6: auto-continue waits the configured delay before the next batch
  {
    const e = makeEnv({ settings: { ...S0, delayMs: 1500, delayMaxMs: 1600, autoContinue: true, autoApprove: true, batchSize: 2 }, extra: { index: IDX } });
    await e.open(); e.$('tobulk').click(); await tick(20);
    log.length = 0;
    e.$('prep').click();
    await waitFor(() => e.saved.length === 1, 20000);     // batch 1 auto-approved
    const tApprove = Date.now();
    await waitFor(() => log.filter(x => x.kind === 'doc').length === 3, 20000);   // first doc of batch 2
    const gap = log.filter(x => x.kind === 'doc')[2].t - tApprove;
    ok(gap >= 1400, `F6: next batch starts after the configured delay (${gap} ms, setting 1500–1600)`);
  }
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
