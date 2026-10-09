// Simulated TIPS Reader tab for the redesigned panel: single-LI flow + bulk view.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');
const OUT = __dirname + '/shots/'; fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// Index: 14 topics containing "0787" (…078770-078783), plus LI54.30-P-061245 and fillers
const topics = [];
for (let i = 0; i < 14; i++) topics.push({ tips: `LI42.10-P-0787${70 + i}`, tipsId: 'a' + i, version: 1 + (i % 3), title: 'Door module topic ' + i, modificationDate: 1e12 + i });
topics.find(t => t.tips === 'LI42.10-P-078779').version = 5;
topics.push({ tips: 'LI54.30-P-061245', tipsId: 'b1', version: 2, title: 'Instrument cluster topic', modificationDate: 1e12 + 50 });
for (let i = 0; i < 30; i++) topics.push({ tips: `LI82.00-P-0701${String(i).padStart(2, '0')}`, tipsId: 'c' + i, version: 1, title: 'Filler ' + i, modificationDate: 1e12 + 100 + i });
const byId = Object.fromEntries(topics.map(t => [t.tipsId, t]));
const log = [];

async function fakeFetch(url, init = {}) {
  const u = String(url);
  if (u.includes('/topics/search')) {
    const b = JSON.parse(init.body);
    if (b.docName) { log.push('search:' + b.docName); const h = topics.filter(t => t.tips === b.docName); return { ok: true, status: 200, json: async () => ({ totalHits: h.length, hits: h }) }; }
    const { pageNumber: p, pageSize: n } = b.pagination, st = (p - 1) * n;
    return { ok: true, status: 200, json: async () => ({ totalHits: topics.length, hits: topics.slice(st, st + n) }) };
  }
  if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: 'o1' }) };
  if (u.includes('/file/topics/')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1024 * 300) };
  let m = u.match(/\/topics\/(\w+)\/(\d+)\?/);
  if (m) {
    const t = byId[m[1]], nAtt = t.tips === 'LI42.10-P-078779' ? 2 : t.tips === 'LI54.30-P-061245' ? 1 : 0;
    const attachments = Array.from({ length: nAtt }, (_, k) => ({ attId: k, filename: `att${k}.pdf`, type: 'PDF', dataUrl: `https://x/y?readKey=rk${t.tipsId}${k}`, i18nDescription: { en: 'd' } }));
    return { ok: true, status: 200, json: async () => ({ version: t.version, attachments, references: [], history: { children: [] } }) };
  }
  if (u.includes('/download/url')) return { ok: true, status: 200, json: async () => ({ url: 'https://s3.example/' + u.slice(-6) }) };
  if (u.startsWith('https://s3.example/')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1024 * 100) };
  return { ok: false, status: 404 };
}

function makeEnv(settings, extra = {}) {
  const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings, ...extra }, saved = [];
  w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { saved.push(this.download); };
  w.chrome = { storage: { local: { get: async k => ({ [k]: st[k] }), set: async o => Object.assign(st, o) } }, runtime: { onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true;
  w.fetch = fakeFetch;
  require('./helpers/pdf-fixture').installPdfFixtures(w);
  w.eval(probe); w.eval(fs.readFileSync(require('path').join(__dirname, '..', 'index-csv.js'), 'utf8')); w.eval(content);
  const env = { w, st, saved, root: () => [...w.document.documentElement.children].find(e => e.shadowRoot).shadowRoot };
  env.$ = id => env.root().getElementById(id);
  env.text = () => { const r = (env.root().querySelector('.dr') || env.w.document.createElement('div')), tw = w.document.createTreeWalker(r, 4), a = []; while (tw.nextNode()) if (tw.currentNode.parentElement.tagName !== 'STYLE') a.push(tw.currentNode.textContent); return a.join(' ').replace(/\s+/g, ' '); };
  env.shot = name => fs.writeFileSync(OUT + name + '.html', `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:20px;background:#e7e5e0"><div id="h"></div><script>document.getElementById('h').attachShadow({mode:'open'}).innerHTML = ${JSON.stringify(env.root().innerHTML).replace(/<\//g, '<\/')};</script></body>`);
  env.type = v => { const t = env.$('li'); t.value = v; t.dispatchEvent(new w.Event('input')); };
  return env;
}
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(20); } }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const S0 = { outlet: 'o1', user: '[USER]', ver: '1.22.0', delayMs: 200, delayMaxMs: 400, pageSize: 20, pageSizeSrc: 'detected', batchSize: 4, autoContinue: false };
const index = topics.map(t => ({ tips: t.tips, tipsId: t.tipsId, version: t.version, title: t.title, mdate: 0 }));

(async () => {
  const e = makeEnv({ ...S0 }, { index, done: {} });
  await tick(100);
  e.shot('0_fab');
  ok(!e.root().querySelector('.dr'), 'closed: nothing floats over the page');
  e.w.__toggle({ type: 'toggle' }, null, () => { }); await tick(50);
  e.shot('1_ready_empty');
  ok(!e.$('library_panel').hidden && e.$('advanced_panel').hidden, 'drawer opens on the local Library screen');
  e.$('toadvanced').click();
  ok(e.$('tosingle').getAttribute('aria-selected') === 'true' && e.$('tobulk'), 'Advanced contains Single LI and Bulk export tabs');

  // Look up: full number, unique ending, ambiguous fragment, unknown
  e.type('LI42.10-P-078779, 061245\n0787 999999');
  e.$('look').click();
  await waitFor(() => e.$('dlfound'));
  e.shot('2_looked');
  const t = e.text();
  ok(/Found in TIPS : 2 of 4 entries/i.test(t), 'shows found count (2 of 4)');
  ok(/LI42\.10-P-078779 v5 · 4 prior/.test(t), 'full number resolved with version and prior count');
  ok(/LI54\.30-P-061245 v2 · 1 prior .* from “061245”/.test(t), 'unique ending resolved and labelled');
  ok(/0787 Matches 14 topics\. Type more of the number\./.test(t), 'ambiguous fragment explained');
  ok(/999999 Not found in the index\./.test(t), 'unknown entry explained');
  ok(/Download 2/.test(t) && /TIPS_selection_\d{4}-\d\d-\d\d_2docs\.zip/.test(t), 'download button + target filename');
  ok(log.filter(x => x.startsWith('search:')).length === 2, 'only resolvable entries are searched live');

  // Editing the box after lookup drops the stale results (and keeps focus)
  e.$('li').focus(); e.type('LI42.10-P-078779, 061245\n0787 9999990');
  ok(!e.$('dlfound') && e.$('look') && e.root().activeElement && e.root().activeElement.id === 'li', 'editing clears stale results, keeps focus');
  e.type('LI42.10-P-078779, 061245\n0787');
  e.$('look').click(); await waitFor(() => e.$('dlfound'));

  // Download
  e.$('dlfound').click();
  await waitFor(() => /in progress/.test(e.text()));
  await waitFor(() => /Prior version v\d – \d of 4/.test(e.text()));
  e.shot('3_downloading');
  ok(/● Downloading/.test(e.text()) && /queued/.test(e.text()), 'downloading view: status, current doc, queued doc');
  ok(/✓ Topic data & current PDF/.test(e.text()) && /✓ 2 attachments/.test(e.text()), 'step checklist ticks off finished steps');
  await waitFor(() => /Saved to Downloads/.test(e.text()));
  e.shot('4_saved');
  const d = e.text();
  ok(e.saved.length === 1 && /TIPS_selection_.*_2docs\.zip/.test(e.saved[0]), 'zip saved: ' + e.saved[0]);
  ok(/Documents 2 of 2/.test(d) && /Attachments 3/.test(d) && /Prior versions 5/.test(d), 'saved summary: 2 of 2 documents, 3 attachments, 5 prior versions');
  ok(/1 entry skipped 0787 – Matches 14 topics/.test(d), 'skipped entry listed');
  ok(e.st.recent && e.st.recent.length === 1 && e.st.recent[0].docs === 2, 'recent download stored');
  ok(/Recent downloads Check for updates 2 documents LI42\.10-P-078779, LI54\.30-P-061245 · [\d.]+ MB · today/.test(d), 'recent list shows it');

  // Fix puts skipped entries back
  e.$('fix').click(); await tick(20);
  ok(e.$('li').value === '0787' && e.$('look'), 'Fix puts skipped entry back in the box');
  e.shot('5_fix');

  // Redo from recent: single doc
  e.type('078779'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
  e.$('dlfound').click(); await waitFor(() => /Saved to Downloads/.test(e.text()));
  ok(e.saved[1] === 'LI42.10-P-078779 - Door module topic 9.zip', 'single doc saved as <LI> - <Title>.zip');
  ok(/LI42\.10-P-078779 v5 · [\d.]+ MB · today/.test(e.text()), 'single recent entry shows version');
  e.$('newdl').click(); await tick(20);
  e.root().querySelector('[data-redo="1"]').click();
  await waitFor(() => e.$('dlfound'));
  ok(e.$('li').value === 'LI42.10-P-078779\nLI54.30-P-061245' && /Download 2/.test(e.text()), 'recent ↻ looks the same documents up again');
  e.$('clear').click(); await tick(20);
  e.shot('6_ready_recent');

  // Cancel during a single download
  e.type('LI42.10-P-078779 LI54.30-P-061245'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
  const n0 = e.saved.length;
  e.$('dlfound').click(); await waitFor(() => e.$('cancel'));
  e.$('cancel').click();
  await waitFor(() => /cancelled – nothing saved/.test(e.text()));
  ok(e.saved.length === n0 && e.$('dlfound'), 'cancel saves nothing and keeps the looked-up list');

  // Bulk view
  e.$('msgx').click(); await tick(10);
  e.$('tobulk').click(); await tick(20);
  e.shot('7_bulk_home');
  ok(e.$('prep') && /Prepare batch 1/.test(e.text()) && e.$('tosingle'), 'bulk view with Prepare batch 1 and back link');
  e.$('prep').click();
  await waitFor(() => /Batch 1 running/.test(e.text()));
  await waitFor(() => e.$('plabel') && /Document [23] of 4/.test(e.text()));
  e.shot('8_bulk_running');
  ok(e.$('pbar') && /Document [23] of 4/.test(e.text()), 'batch progress: bar + document counter');
  e.$('tosingle').click(); await tick(20);
  ok(e.$('li').disabled && /Batch 1 running/.test(e.text()), 'single view is locked while a batch runs; header shows it');
  e.$('tobulk').click();
  await waitFor(() => e.$('approve'));
  e.shot('9_bulk_review');
  ok(/Awaiting approval/.test(e.text()) && /Batch 1 is ready/.test(e.text()), 'review state');
  e.$('approve').click(); await tick(50);
  ok(e.saved.at(-1) === 'TIPS_LI_Batch_001.zip' && Object.keys(e.st.done).length === 4, 'approve downloads batch and records progress');

  // Settings panel
  e.$('gear').click(); await tick(10);
  e.$('f_docJson').click(); await tick(20); e.$('f_histJson').click(); await tick(20);
  e.shot('10_settings');
  ok(e.$('s_save') && e.$('s_ps') && e.$('s_delay2'), 'settings panel renders');
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
