// QA round 2 regressions: CSV round-trip, locks between flows, double Approve, auto-continue vs Check new,
// id types, focus across re-renders, popup vs drawer, empty titles.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(20); } }
function makeEnv({ fetch, extra = {}, settings = {}, body = '', storeDelay = 0, path = '/tips-reader/search/topics' }) {
  const dom = new JSDOM(`<!doctype html><body>TIPS Reader v1.22.0 - 2026<xy-c-side-navigation><footer><xy-c-aux-menu id="auxMenu0"><div></div><button class="xy-test-standard-trigger"></button></xy-c-aux-menu></footer></xy-c-side-navigation><div class="xy-c-card-list-wrapper"><div>${body}</div></div></body>`,
    { url: 'https://xentry.mercedes-benz.com' + path, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 50, delayMaxMs: 80, pageSize: 50, pageSizeSrc: 'detected', batchSize: 4, autoContinue: false, autoCheck: false, ...settings }, ...extra }, saved = [];
  w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = b => { saved.push({ blob: b }); return 'blob:x'; }; w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { saved[saved.length - 1].name = this.download; };
  w.chrome = { storage: { local: { get: async k => ({ [k]: JSON.parse(JSON.stringify(st[k] ?? null)) ?? undefined }), set: async o => { if (storeDelay) await tick(storeDelay); Object.assign(st, JSON.parse(JSON.stringify(o))); } } }, runtime: { getManifest: () => ({ version: 'qa' }), onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true; w.fetch = fetch;
  require('./helpers/pdf-fixture').installPdfFixtures(w);
  w.eval(probe); w.eval(fs.readFileSync(require('path').join(__dirname, '..', 'index-csv.js'), 'utf8')); w.eval(content);
  const shadows = () => [...w.document.documentElement.children].filter(e => e.shadowRoot).map(e => e.shadowRoot);
  const root = () => shadows().find(r => r.querySelector('.dr')) || shadows()[0];
  const env = { w, st, saved, root, $: id => root().getElementById(id) };
  env.text = () => { const r = root().querySelector('.dr'); if (!r) return ''; const tw = w.document.createTreeWalker(r, 4), a = []; while (tw.nextNode()) if (tw.currentNode.parentElement.tagName !== 'STYLE') a.push(tw.currentNode.textContent); return a.join(' ').replace(/\s+/g, ' '); };
  env.open = async () => { await tick(80); w.__toggle({ type: 'toggle' }, null, () => { }); await tick(30); };
  env.type = v => { const t = env.$('li'); t.value = v; t.dispatchEvent(new w.Event('input')); };
  return env;
}
const T = [
  { tips: 'LI42.10-P-078779', tipsId: 101, version: 3, title: 'Brake, "vibration"\nfrom 60MPH' },
  { tips: 'LI46.10-P-070001', tipsId: 102, version: 2, title: 'Steering' },
  { tips: 'LI54.10-P-080684', tipsId: 103, version: 1, title: 'Charging' },
  { tips: 'LI20.10-P-075374', tipsId: 104, version: 1, title: 'Coolant' }];
function makeFetch(opts = {}) {
  const log = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    if (opts.hook) { const r = await opts.hook(u, init, log); if (r) return r; }
    if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: 'o1' }) };
    if (u.includes('/topics/search')) {
      const b = JSON.parse(init.body); log.push({ kind: 'search', body: b });
      const list = opts.topics || T;
      let hits = b.docName ? list.filter(t => t.tips === b.docName) : [...list].sort((a, c) => String(a.modificationDate||'').localeCompare(String(c.modificationDate||''))); if (!b.docName && b.sortorder && b.sortorder.order === 'desc') hits.reverse();
      const { pageNumber: p, pageSize: n } = b.pagination;
      return { ok: true, status: 200, json: async () => ({ totalHits: hits.length, hits: hits.slice((p - 1) * n, p * n).map(t => ({ modificationDate: '2026-10-01T00:00:00Z', ...t })) }) };
    }
    let m = u.match(/\/file\/topics\/(\d+)\/(\d+)\?/);
    if (m) { log.push({ kind: 'pdf', id: m[1], v: m[2] }); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(1024).buffer }; }
    m = u.match(/\/topics\/(\d+)\/(\d+)\?/);
    if (m) { log.push({ kind: 'data', id: m[1] }); return { ok: true, status: 200, json: async () => ({ version: +m[2], attachments: [], references: [], history: { children: [] } }) }; }
    return { ok: false, status: 404 };
  };
  f.log = log; return f;
}

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

(async () => {
  // Q1. progress log round-trip: titles with line breaks, quotes, commas; junk rows ignored
  {
    const e = makeEnv({ fetch: makeFetch() });
    await tick(120);
    const D = e.w.__TIPSX_DEBUG;   // undefined with chrome present – use the UI-free path via the debug-less store
    ok(!D, 'debug hook stays off inside the extension');
  }
  {
    // without chrome: debug hook available
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body>x</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window; w.TextEncoder = TextEncoder; w.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    w.eval(fs.readFileSync(require('path').join(__dirname, '..', 'index-csv.js'), 'utf8')); w.eval(content); await tick(120);
    const D = w.__TIPSX_DEBUG;
    D.S.index = [
      { tips: 'LI42.10-P-078779', tipsId: 101, version: 3, title: 'Brake "vibration", 60MPH', mdate: '2026-10-01T00:00:00Z' },
      { tips: 'LI46.10-P-070001', tipsId: 102, version: 2, title: 'Steering\nassist loss', mdate: '2026-10-02T00:00:00Z' },
      { tips: 'LI54.10-P-080684', tipsId: 103, version: 1, title: 'Charging', mdate: '2026-10-03T00:00:00Z' }];
    D.S.done = { 101: { b: 1, d: 'x', v: 3 }, 102: { b: 1, d: 'x', v: 2 } };
    const csv = D.progressCsv();
    ok(csv.split('\r\n').length === 4, 'Save log: one line per topic (line breaks in titles flattened)');
    await D.importLog(csv);
    ok(D.S.index.length === 3 && Object.keys(D.S.done).length === 2 && D.S.index[1].title === 'Steering assist loss' && D.S.index[0].title === 'Brake "vibration", 60MPH', 'Import log restores 3 topics, 2 exported, titles intact');
    // a log written by an older version / edited in Excel: quoted line break inside a field, blank and junk lines
    const old = 'index,batch,tips,tipsId,version_indexed,title,modification_date,status,exported_on\r\n'
      + '"1","1","LI42.10-P-078779","101","3","Brake\nvibration","2026-10-01T00:00:00Z","exported","x"\r\n\r\n'
      + '"2","","LI46.10-P-070001","102","2","Steering","2026-10-02T00:00:00Z","pending",""\r\n",,,,,,,,"\r\n';
    await D.importLog(old);
    ok(D.S.index.length === 2 && D.S.index[0].title === 'Brake\nvibration' && D.S.done[101] && !D.S.index.some(x => Number.isNaN(x.tipsId)), 'older log with a line break inside quotes imports correctly; junk rows skipped');
    D.S.done = { a: { b: 7 } }; D.S.history = Array.from({ length: 200000 }, (_, i) => ({ n: i }));
    let nb; try { nb = D.nextBatch(); } catch (err) { nb = err.message; }
    ok(nb === 200000 || D.S.index.every(x => D.S.done[x.tipsId]), 'next batch number works with a very long history (' + nb + ')');
  }

  // Q2. Prepare is unavailable while a Single-LI lookup runs; a failing lookup never kills a batch
  {
    const f = makeFetch({ hook: async (u, init) => {
      if (u.includes('/topics/search')) { const b = JSON.parse(init.body); if (b.docName === 'LI20.10-P-075374') { await tick(600); return { ok: false, status: 500, json: async () => ({}) }; } }
    } });
    const e = makeEnv({ fetch: f, extra: { index: T.map(t => ({ ...t, mdate: '2026-10-01T00:00:00Z' })), done: {} } });
    await e.open();
    e.type('LI42.10-P-078779 LI20.10-P-075374'); e.$('look').click(); await tick(50);
    e.$('tobulk').click(); await tick(20);
    ok(e.$('prep').disabled && e.$('refresh').disabled, 'while a lookup runs: Prepare and Check new are disabled');
    await waitFor(() => /search HTTP 500/.test(e.text()));
    ok(!e.$('prep').disabled, 'after the lookup failed: Prepare is available again');
    e.$('prep').click(); await waitFor(() => e.$('approve'));
    ok(/Batch 1 is ready/.test(e.text()), 'batch runs normally afterwards');
  }

  // Q3. Approve double-click → one zip, one history entry; Discard during save does nothing
  {
    const e = makeEnv({ fetch: makeFetch(), extra: { index: T.map(t => ({ ...t, mdate: '2026-10-01T00:00:00Z' })), done: {} }, storeDelay: 40 });
    await e.open(); e.$('tobulk').click(); await tick(20);
    e.$('prep').click(); await waitFor(() => e.$('approve'));
    const a = e.$('approve'), d = e.$('discard');
    a.click(); a.click(); d.click(); await tick(300);
    ok(e.saved.length === 1 && e.st.history.length === 1 && Object.keys(e.st.done).length === 4 && !/Discarded/.test(e.text()), `double Approve + Discard: ${e.saved.length} zip, ${e.st.history.length} history entry`);
  }

  // Q4. Auto-continue waits for a running Check new; a newer version found meanwhile is not lost
  {
    const topics = Array.from({ length: 8 }, (_, i) => ({ tips: `LI42.10-P-07000${i}`, tipsId: 200 + i, version: 1, title: 't' + i, modificationDate: '2026-09-0' + (i + 1) + 'T00:00:00Z' }));
    let slow = false;
    const f = makeFetch({ topics, hook: async u => { if (slow && u.includes('/topics/search')) await tick(1500); } });
    const IDX = topics.map(t => ({ tips: t.tips, tipsId: t.tipsId, version: 1, title: t.title, mdate: t.modificationDate }));
    const e = makeEnv({ fetch: f, extra: { index: IDX, done: {} }, settings: { autoContinue: true } });
    await e.open(); e.$('tobulk').click(); await tick(20);
    e.$('prep').click(); await waitFor(() => e.$('approve'));
    e.$('approve').click(); await tick(30);
    Object.assign(topics[5], { version: 2, modificationDate: '2026-10-04T00:00:00Z' });
    slow = true; e.$('refresh').click(); await tick(100);
    const before = f.log.filter(x => x.kind === 'data').length;
    await waitFor(() => e.st.lastCheck, 10000);
    ok(f.log.filter(x => x.kind === 'data').length === before, 'no batch document fetched while the check ran');
    await waitFor(() => e.$('approve'), 15000);
    ok(/Batch 2 is ready/.test(e.text()), 'auto-continue started batch 2 after the check finished');
    e.$('approve').click(); await tick(200);
    const ix = e.st.index.find(x => x.tipsId === 205);
    ok(ix.version === 2 && e.st.done[205] && e.st.done[205].v === 2, `topic 205 exported at the new version (index v${ix.version}, done v${e.st.done[205] && e.st.done[205].v})`);
  }

  // Q5. Build index locks Check new / Build / Import / Prepare and reads once; ids compared as text
  {
    const many = Array.from({ length: 200 }, (_, i) => ({ tips: `LI42.10-P-${100000 + i}`, tipsId: 1000 + i, version: 1, title: 't' + i, modificationDate: new Date(Date.parse('2026-01-01') + i * 864e5).toISOString() }));
    const f = makeFetch({ topics: many, hook: async u => { if (u.includes('/topics/search')) await tick(60); } });
    const e = makeEnv({ fetch: f, extra: { index: many.slice(0, 190).map(t => ({ tips: t.tips, tipsId: t.tipsId, version: 1, title: t.title, mdate: t.modificationDate })), done: {} }, settings: { pageSize: 20 } });
    await e.open(); e.$('tobulk').click(); await tick(20);
    e.$('build').click(); await tick(30);
    ok(e.$('build').disabled && e.$('refresh').disabled && e.$('imp').disabled && e.$('prep').disabled, 'during Build index: Build, Check new, Import and Prepare are disabled');
    e.$('build').click(); e.$('refresh').click();
    await waitFor(() => /Index built/.test(e.text()), 20000);
    const searches = f.log.filter(x => x.kind === 'search').length, ids = e.st.index.map(x => x.tipsId);
    ok(searches === 10 && ids.length === 200 && new Set(ids).size === 200, `one pass (${searches} requests), 200 unique topics`);
    // TIPS sends ids as text, index holds numbers (as Import log stores them)
    const topics = many.slice(0, 6).map(t => ({ ...t, tipsId: String(t.tipsId) }));
    const e2 = makeEnv({ fetch: makeFetch({ topics }), extra: { index: many.slice(0, 6).map(t => ({ tips: t.tips, tipsId: t.tipsId, version: 1, title: t.title, mdate: t.modificationDate })), done: {} } });
    await e2.open(); e2.$('tobulk').click(); await tick(20);
    e2.$('refresh').click(); await waitFor(() => /no new|appended/.test(e2.text()));
    ok(e2.st.index.length === 6 && /no new or updated topics/.test(e2.text()), 'text vs number topic ids: nothing reported as new');
  }

  // Q6. Keyboard focus survives progress re-renders; popup never opens over the drawer
  {
    const f = makeFetch({ hook: async u => { if (u.includes('/file/topics/')) await tick(150); } });
    const e = makeEnv({ fetch: f, extra: { index: T.map(t => ({ ...t, mdate: '2026-10-01T00:00:00Z' })), done: {} } });
    await e.open(); e.$('tobulk').click(); await tick(20);
    e.$('prep').click(); await tick(30);
    e.$('pause').focus();
    await tick(900);
    ok(e.root().activeElement && e.root().activeElement.id === 'pause', 'focus stays on Pause while documents advance');
    e.$('gear').click(); await tick(10);
    const u = e.$('s_outlet'); u.closest('details').open = true; u.focus(); u.value = 'abc'; u.dispatchEvent(new e.w.Event('input')); u.setSelectionRange(1, 1);
    await tick(900);
    const a = e.root().activeElement;
    ok(a && a.id === 's_outlet' && a.closest('details').open && a.value === 'abc' && a.selectionStart === 1, 'focus, value and caret stay in Settings → Outlet while documents advance');
    e.$('cancel') && e.$('cancel').click();
  }
  {
    const topics = Array.from({ length: 6 }, (_, i) => ({ tips: `LI42.10-P-07000${i}`, tipsId: 200 + i, version: 1, title: 't' + i, modificationDate: '2026-09-0' + (i + 1) + 'T00:00:00Z' }));
    const e = makeEnv({ fetch: makeFetch({ topics }), extra: { index: topics.slice(0, 5).map(t => ({ tips: t.tips, tipsId: t.tipsId, version: 1, title: t.title, mdate: t.modificationDate })), done: {} }, settings: { autoCheck: true } });
    await e.open();
    await waitFor(() => e.st.lastCheck, 10000); await tick(100);
    const note = [...e.w.document.documentElement.children].some(x => x.shadowRoot && x.shadowRoot.querySelector('.nt'));
    ok(!note && /When TIPS loaded: .*1 new topic/.test(e.text()), 'drawer already open when the load-time check finds something: message in the drawer, no popup on top');
  }

  // Q7. empty title → LI number alone (no trailing " - ", and no "(Requested)" label since 1.21.0)
  {
    const topics = [{ tips: 'LI42.10-P-078779', tipsId: 101, version: 1, title: '' }];
    const e = makeEnv({ fetch: makeFetch({ topics }), extra: { index: [], done: {} } });
    await e.open();
    e.type('LI42.10-P-078779'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
    e.$('dlfound').click(); await waitFor(() => /Saved to Downloads/.test(e.text()));
    const ab = await e.saved[0].blob.arrayBuffer();
    const txtz = Buffer.from(ab).toString('latin1');
    ok(/LI42\.10-P-078779\/LI42\.10-P-078779_v1\.pdf/.test(txtz) && !/LI42\.10-P-078779 - /.test(txtz) && !/Requested/.test(txtz), 'empty title: LI number alone, without a dangling separator or a Requested label');
  }
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
