// Session-expiry detection, keeping a batch / an interrupted download across reloads, retries for files that
// failed temporarily, and formula-safe CSV.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(20); } }
function makeEnv({ fetch, extra = {}, settings = {}, body = '', storeDelay = 0, path = '/tips-reader/search/topics', idb = null, st: shared = null }) {
  const dom = new JSDOM(`<!doctype html><body>TIPS Reader v1.22.0 - 2026<xy-c-side-navigation><footer><xy-c-aux-menu id="auxMenu0"><div></div><button class="xy-test-standard-trigger"></button></xy-c-aux-menu></footer></xy-c-side-navigation><div class="xy-c-card-list-wrapper"><div>${body}</div></div></body>`,
    { url: 'https://xentry.mercedes-benz.com' + path, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 50, delayMaxMs: 80, pageSize: 50, pageSizeSrc: 'detected', batchSize: 4, autoContinue: false, autoCheck: false, ...settings }, ...extra }, saved = [];
  w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = b => { saved.push({ blob: b }); return 'blob:x'; }; w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { saved[saved.length - 1].name = this.download; };
  w.chrome = { storage: { local: { get: async k => ({ [k]: JSON.parse(JSON.stringify(st[k] ?? null)) ?? undefined }), set: async o => { if (storeDelay) await tick(storeDelay); Object.assign(st, JSON.parse(JSON.stringify(o))); } } }, runtime: { getManifest: () => ({ version: 'qa' }), onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true; w.fetch = fetch; if (idb) w.indexedDB = idb; if (shared) Object.assign(st, shared);
  // These legacy endpoint fixtures use zero-filled dummy PDFs; real scrubbing is covered by pdf-scrub.test.js.
  st.settings = { pdfScrub: { enabled: false }, ...st.settings };
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

const { IDBFactory } = require('fake-indexeddb');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const IDX = T.map(t => ({ ...t, mdate: '2026-10-01T00:00:00Z' }));
const html = () => ({ ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, json: async () => { throw new SyntaxError('Unexpected token <'); }, arrayBuffer: async () => new ArrayBuffer(10) });

(async () => {
  // R1. session expiry variants all lead to "interrupted – Resume", never to failed documents
  for (const [name, hook] of [
    ['login page returned with HTTP 200 (topic data)', u => /\/topics\/103\//.test(u) && !u.includes('/file/') ? html() : null],
    ['login page returned with HTTP 200 (PDF)', u => /\/file\/topics\/103\//.test(u) ? html() : null],
    ['redirect to the login page on another domain (fetch fails, probe sees the redirect)', u => {
      if (/\/topics\/103\//.test(u)) throw new TypeError('Failed to fetch');
      if (u.includes('/currentuser')) return { ok: false, status: 0, type: 'opaqueredirect', headers: { get: () => '' } };
      return null; }],
    ['same-origin redirect to a login URL', u => /\/topics\/103\//.test(u) ? { ok: true, status: 200, redirected: true, url: 'https://xentry.mercedes-benz.com/auth/login', headers: { get: () => 'text/html' } } : null]]) {
    let expired = true;
    const f = makeFetch({ hook: async u => expired ? hook(u) : null });
    const e = makeEnv({ fetch: f, extra: { index: IDX, done: {} } });
    await e.open(); e.$('tobulk').click(); await tick(20);
    e.$('prep').click(); await waitFor(() => e.$('resume') || e.$('approve'), 30000);
    ok(!!e.$('resume') && /Batch 1 interrupted – 2 of 4 done/.test(e.text()), name + ': batch interrupted, Resume offered');
    expired = false; e.$('resume').click(); await waitFor(() => e.$('approve'), 30000);
    ok(/4 of 4/.test(e.text()), name + ': after logging in, Resume completes all 4');
  }
  {
    // a real network outage is not mistaken for a lost session
    let down = true;
    const f = makeFetch({ hook: async u => { if (down && /\/topics\/103\//.test(u)) throw new TypeError('Failed to fetch'); if (down && u.includes('/currentuser')) throw new TypeError('Failed to fetch'); } });
    const e = makeEnv({ fetch: f, extra: { index: IDX, done: {} } });
    await e.open(); e.$('tobulk').click(); await tick(20);
    e.$('prep').click(); await waitFor(() => e.$('approve'), 40000);
    ok(/3 of 4/.test(e.text()) && !e.$('resume'), 'network outage: that document fails (stays pending), no false "session expired"');
    down = false;
  }

  // R2. a prepared batch and an interrupted download survive a page reload
  {
    const idb = new IDBFactory(), st = {};
    const e = makeEnv({ fetch: makeFetch(), extra: { index: IDX, done: {} }, idb });
    await e.open(); e.$('tobulk').click(); await tick(20);
    e.$('prep').click(); await waitFor(() => e.$('approve'));
    await tick(300);   // written to IndexedDB
    Object.assign(st, JSON.parse(JSON.stringify({ index: e.st.index, done: e.st.done, history: e.st.history, settings: e.st.settings })));
    const e2 = makeEnv({ fetch: makeFetch(), idb, st });   // "reload"
    await waitFor(() => e2.root() && true, 2000); await tick(300);
    e2.w.__toggle({ type: 'toggle' }, null, () => { }); await tick(50);
    ok(!!e2.$('approve') && /TIPS_LI_Batch_001\.zip from before the page was reloaded is still waiting for approval/.test(e2.text()) && /Batch 1 is ready/.test(e2.text()), 'reload: the prepared batch is still there for approval');
    e2.$('approve').click(); await tick(150);
    ok(e2.saved.length === 1 && e2.saved[0].name === 'TIPS_LI_Batch_001.zip' && e2.saved[0].blob.size > 4000 && Object.keys(e2.st.done).length === 4, 'approve after reload: zip saved (' + e2.saved[0].blob.size + ' bytes), 4 marked exported');
    const e3 = makeEnv({ fetch: makeFetch(), idb, st: { index: IDX, done: {} } });
    await tick(400);
    e3.w.__toggle({ type: 'toggle' }, null, () => { }); await tick(50);
    ok(!e3.$('approve'), 'once approved it is gone after the next reload');

    // interrupted single download
    let expired = false;
    const f = makeFetch({ hook: async u => expired && /\/file\/topics\/103\//.test(u) ? { ok: false, status: 401 } : null });
    const s = makeEnv({ fetch: f, extra: { index: IDX, done: {} }, idb });
    await s.open();
    s.type('LI42.10-P-078779 LI54.10-P-080684 LI20.10-P-075374'); s.$('look').click(); await waitFor(() => s.$('dlfound'));
    expired = true; s.$('dlfound').click(); await waitFor(() => s.$('resume'), 30000);
    await tick(300); expired = false;
    const s2 = makeEnv({ fetch: makeFetch(), idb, st: { index: IDX, done: {} } });
    await tick(400);
    s2.w.__toggle({ type: 'toggle' }, null, () => { }); await tick(50);
    ok(!!s2.$('resume') && /Download interrupted – 1 of 3 done/.test(s2.text()), 'reload: the interrupted download can still be resumed');
    s2.$('resume').click(); await waitFor(() => /Saved to Downloads/.test(s2.text()), 30000);
    const ab = await new Promise(r => { const fr = new s2.w.FileReader(); fr.onload = () => r(fr.result); fr.readAsArrayBuffer(s2.saved[0].blob); });
    const z = Buffer.from(ab).toString('latin1');
    ok(s2.saved[0].name === 'TIPS_selection_' + new Date().toISOString().slice(0, 10) + '_3docs.zip' && /LI42\.10-P-078779_v3\.pdf/.test(z) && /LI20\.10-P-075374_v1\.pdf/.test(z), 'resumed after reload: one zip with all 3 documents (' + s2.saved[0].name + ')');
  }

  // R3. temporary file failures: document is "incomplete", retried in the next batch, given up after 3 tries
  {
    let flaky = true;
    const f = makeFetch({ hook: async u => (flaky && /\/file\/topics\/101\/1\?/.test(u)) ? { ok: false, status: 503 } : null });   // prior version v1 of 101 keeps failing
    const e = makeEnv({ fetch: f, extra: { index: IDX, done: {} }, settings: { batchSize: 4 } });
    await e.open(); e.$('tobulk').click(); await tick(20);
    for (let round = 1; round <= 3; round++) {
      e.$('prep').click(); await waitFor(() => e.$('approve'), 40000);
      if (round === 1) ok(/Documents 4 of 4 \(1 incomplete – retried next batch\)/.test(e.text()), 'review shows the incomplete document');
      e.$('approve').click(); await tick(150);
      if (round === 1) ok(!e.st.done[101] && Object.keys(e.st.done).length === 3 && e.st.retry[101] === 1 && /1 incomplete document\(s\) stay pending/.test(e.text()), 'after approve: the incomplete document stays pending (try 1 of 3)');
      if (round === 2) ok(!e.st.done[101] && e.st.retry[101] === 2, 'second batch: still failing, still pending (try 2 of 3)');
    }
    ok(e.st.done[101] && e.st.done[101].missing === 1 && !e.st.retry[101] && /still had missing files after 3 tries/.test(e.text()), 'third try: recorded as exported with 1 missing file, no endless retries');
    // a version TIPS does not have: PDF endpoint says 500, topic data says 404 → recorded once, no retries
    const g = makeFetch({ hook: async u => /\/file\/topics\/101\/1\?/.test(u) ? { ok: false, status: 500 } : /\/topics\/101\/1\?/.test(u) ? { ok: false, status: 404 } : null });
    const e2 = makeEnv({ fetch: g, extra: { index: IDX, done: {} } });
    await e2.open(); e2.$('tobulk').click(); await tick(20);
    e2.$('prep').click(); await waitFor(() => e2.$('approve'), 40000); e2.$('approve').click(); await tick(150);
    ok(Object.keys(e2.st.done).length === 4, 'a version TIPS does not have (PDF 500, data 404) is listed as an error but does not hold the document back');
  }

  // R4. CSV: values that look like spreadsheet formulas are neutralised and come back unchanged on import
  {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body>x</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window; w.TextEncoder = TextEncoder; w.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    w.eval(fs.readFileSync(require('path').join(__dirname, '..', 'index-csv.js'), 'utf8')); w.eval(content); await tick(120);
    const D = w.__TIPSX_DEBUG;
    D.S.index = [{ tips: 'LI42.10-P-078779', tipsId: 101, version: 3, title: '=HYPERLINK("http://x","click")', mdate: '2026-10-01T00:00:00Z' },
      { tips: 'LI46.10-P-070001', tipsId: 102, version: 2, title: '-12V supply low', mdate: '2026-10-02T00:00:00Z' }];
    D.S.done = {};
    const csv = D.progressCsv();
    ok(csv.includes(`"'=HYPERLINK(""http://x"",""click"")"`) && csv.includes(`"'-12V supply low"`) && !/,"=/.test(csv), 'Save log: formula-like titles start with an apostrophe');
    await D.importLog(csv);
    ok(D.S.index[0].title === '=HYPERLINK("http://x","click")' && D.S.index[1].title === '-12V supply low', 'Import log: titles restored exactly');
  }
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
