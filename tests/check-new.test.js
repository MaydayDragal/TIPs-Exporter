// "Check new" reads only the newest topics (TIPS search by modification date, newest first) and stops at topics
// that were already indexed. It also runs by itself whenever TIPS loads, and opens the "New in TIPS" popup when
// it finds something.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');

const DAY = 864e5, NOW = Date.parse('2026-10-05T12:00:00Z');
const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');
// 3000 topics, one modified per day going back from NOW (dates as the Reader sends them: ISO strings)
let topics;
function reset(dated = true) {
  topics = Array.from({ length: 3000 }, (_, i) => ({ tips: `LI${String(10 + i % 80).padStart(2, '0')}.10-P-${200000 + i}`, tipsId: 5000 + i, version: 1 + i % 4, title: 'Topic ' + i, modificationDate: dated ? iso(NOW - (3000 - i) * DAY) : 1e12 + i }));
}
const log = [];
let expire = false;
async function fakeFetch(url, init = {}) {
  const u = String(url);
  if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: 'o1' }) };
  if (u.includes('/topics/search')) {
    if (expire) return { ok: false, status: 401, json: async () => ({}) };
    const b = JSON.parse(init.body), { pageNumber: p, pageSize: n } = b.pagination;
    log.push({ kind: 'search', p, n, order: b.sortorder.order });
    const key = t => typeof t.modificationDate === 'number' ? t.modificationDate : Date.parse(t.modificationDate);
    const sorted = [...topics].sort((a, c) => key(a) - key(c));
    if (b.sortorder.order === 'desc') sorted.reverse();
    return { ok: true, status: 200, json: async () => ({ totalHits: sorted.length, hits: sorted.slice((p - 1) * n, p * n) }) };
  }
  if (u.includes('/file/topics/')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) };
  const m = u.match(/\/topics\/(\d+)\/(\d+)\?/);
  if (m) return { ok: true, status: 200, json: async () => ({ version: +m[2], attachments: [], references: [], history: { children: [] } }) };
  return { ok: false, status: 404 };
}
const STAR = `<div class="tips-top-filter"><div class="filter-bar-mobile xy-d-flex"><form>
  <xy-c-dropdown style="float:left"><select id="-select"><option value="newest">Newest</option></select></xy-c-dropdown>
  <xy-c-button-bar style="float:right"><ul class="xy-list-reset xy-d-flex"><li class="xy-button-bar-button"><input id="0_favorites" type="checkbox"><label for="0_favorites" class="xy-i-star-filled"></label></li></ul></xy-c-button-bar>
</form></div></div>`;

function makeEnv(extra = {}, settings = { autoCheck: false }, path = '/tips-reader/search/topics') {
  const dom = new JSDOM(`<!doctype html><head></head><body>TIPS Reader v1.22.0 - 2026<xy-c-side-navigation><footer><xy-c-aux-menu id="auxMenu0"><div></div><button class="xy-test-standard-trigger"></button></xy-c-aux-menu></footer></xy-c-side-navigation>${STAR}</body>`,
    { url: 'https://xentry.mercedes-benz.com' + path, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 50, delayMaxMs: 80, pageSize: 50, pageSizeSrc: 'detected', batchSize: 3, autoContinue: false, ...settings }, ...extra };
  w.TextEncoder = TextEncoder; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { };
  w.chrome = { storage: { local: { get: async k => ({ [k]: st[k] }), set: async o => Object.assign(st, o) } }, runtime: { getManifest: () => ({ version: '1.11.0' }), onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true; w.fetch = fakeFetch;
  require('./helpers/pdf-fixture').installPdfFixtures(w);
  w.eval(probe); w.eval(fs.readFileSync(require('path').join(__dirname, '..', 'index-csv.js'), 'utf8')); w.eval(content);
  const shadows = () => [...w.document.documentElement.children].filter(e => e.shadowRoot).map(e => e.shadowRoot);
  const root = () => shadows().find(r => r.querySelector('.dr')) || shadows()[0];
  const env = { w, st, root, $: id => root().getElementById(id) };
  env.note = () => { for (const r of shadows()) { const x = r.querySelector('.nt'); if (x) return x; } return null; };
  env.N = id => { const n = env.note(); return n && n.parentNode.getElementById(id); };
  env.noteText = () => env.note() ? env.note().textContent.replace(/\s+/g, ' ') : '';
  env.text = () => { const r = root().querySelector('.dr'); if (!r) return ''; const tw = w.document.createTreeWalker(r, 4), a = []; while (tw.nextNode()) if (tw.currentNode.parentElement.tagName !== 'STYLE') a.push(tw.currentNode.textContent); return a.join(' ').replace(/\s+/g, ' '); };
  env.openBulk = async () => { if (!root().querySelector('.dr')) { w.__toggle({ type: 'toggle' }, null, () => { }); await tick(30); } env.$('tobulk').click(); await tick(20); };
  return env;
}
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(20); } }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const indexOf = list => list.map(t => ({ tips: t.tips, tipsId: t.tipsId, version: t.version, title: t.title, mdate: t.modificationDate }));
const searches = () => log.filter(x => x.kind === 'search');

(async () => {
  // ---- 1. drawer: nothing new → one page of the newest topics, not the whole catalogue
  reset();
  {
    const idx = indexOf(topics), done = Object.fromEntries(idx.slice(0, 2900).map(x => [x.tipsId, { b: 1, d: 'x', v: x.version }]));
    const e = makeEnv({ index: idx, done });
    await tick(150);
    ok(!e.w.document.querySelector('.tipsx-chk, .tipsx-chkwrap'), 'no Check new button on the TIPS page');
    await e.openBulk();
    log.length = 0;
    e.$('refresh').click();
    await waitFor(() => /no new or updated topics/.test(e.text()));
    const s = searches();
    ok(s.length === 1 && s.every(x => x.order === 'desc' && x.n === 50), `quick check: ${s.length} request(s), newest first, Reader page size (a full check would be ${Math.ceil(3000 / 50)})`);
    ok(/Checked the 15 most recently changed topics \(back to 2026-09-20\): no new or updated topics\./.test(e.text()), 'message says how far back it looked');
    ok(e.st.index.length === 3000 && Object.keys(e.st.done).length === 2900 && e.st.lastCheck && e.st.lastCheck.fresh === 0, 'index and progress unchanged; last check stored');
    ok(!e.note(), 'manual check from the drawer: no popup');
  }

  // ---- 2. drawer: new topics + new versions are found from the first page
  reset();
  {
    const idx = indexOf(topics), done = Object.fromEntries(idx.map(x => [x.tipsId, { b: 1, d: 'x', v: x.version }]));
    const e = makeEnv({ index: idx, done });
    await tick(150);
    topics.push({ tips: 'LI54.30-P-080760', tipsId: 9001, version: 1, title: 'New A', modificationDate: iso(NOW + 3600e3) });
    topics.push({ tips: 'LI47.70-P-079912', tipsId: 9002, version: 1, title: 'New B', modificationDate: iso(NOW + 7200e3) });
    Object.assign(topics[2990], { version: topics[2990].version + 1, modificationDate: iso(NOW + 1800e3) });
    Object.assign(topics[10], { version: topics[10].version + 1, modificationDate: iso(NOW + 900e3) });
    await e.openBulk();
    log.length = 0;
    e.$('refresh').click();
    await waitFor(() => /appended at the end/.test(e.text()));
    ok(searches().length === 1, `one request (${searches().length})`);
    ok(e.st.index.length === 3002 && e.st.index.slice(-2).map(x => x.tips).join() === 'LI47.70-P-079912,LI54.30-P-080760', 'new topics appended at the end (topic-number order)');
    ok(!e.st.done[topics[2990].tipsId] && !e.st.done[topics[10].tipsId] && Object.keys(e.st.done).length === 2998, 'exported topics with a newer version are re-queued; the rest untouched');
    const items = e.st.lastCheck.items;
    ok(items.length === 4 && items.filter(x => x.kind === 'new').length === 2 && items.some(x => x.kind === 'update' && x.tipsId === topics[10].tipsId && x.prev === topics[10].version - 1 && x.exported), 'last check records each item (new / old → new version, was exported)');
    ok(/2 new topic\(s\) appended at the end \(LI47\.70-P-079912, LI54\.30-P-080760\); 2 topic\(s\) have a newer version .* 2 already-exported one\(s\) re-queued/.test(e.text()), 'drawer message lists them');
    ok(/Last check today \d\d:\d\d: 2 new, 2 updated · 4 waiting to be exported/.test(e.text()), 'Bulk export shows the last check');
    // ---- 3. Shift+click = full comparison of every topic
    topics[500].version += 1;   // changed without a new modification date: only a full check can see it
    e.$('msgx').click(); await tick(10);
    log.length = 0;
    e.$('refresh').dispatchEvent(new e.w.MouseEvent('click', { bubbles: true, shiftKey: true }));
    await waitFor(() => /Checked all/.test(e.text()));
    ok(searches().length >= 60 && /Checked all 3,002 topics: 0 new topic\(s\) appended at the end; 1 topic\(s\) have a newer version \(LI\d\d\.10-P-200500\)/.test(e.text()), 'Shift+click compares every topic (' + searches().length + ' requests)');
  }

  // ---- 4. impossible dates in the index (e.g. year 5300 from an edited log) are skipped and reported
  reset();
  {
    const idx = indexOf(topics); idx[100] = { ...idx[100], mdate: '5300-06-12T00:00:00Z' }; idx[200] = { ...idx[200], mdate: '105098688000000' };
    const e = makeEnv({ index: idx, done: {} });
    await tick(120);
    topics.push({ tips: 'LI54.30-P-080761', tipsId: 9002, version: 1, title: 'New', modificationDate: iso(NOW + 3600e3) });
    await e.openBulk();
    log.length = 0;
    e.$('refresh').click(); await waitFor(() => /appended at the end/.test(e.text()));
    ok(searches().length === 1 && e.st.index.length === 3001, 'bad dates ignored: the new topic is found in one request');
    ok(/Checked the 16 most recently changed topics \(back to 2026-09-20\)/.test(e.text()) && /Ignored 2 impossible modification date\(s\) in the index, e\.g\. LI\d\d\.10-P-200100: "5300-06-12T00:00:00Z"/.test(e.text()), 'message names the bad entry');
  }

  // ---- 5. automatic check whenever TIPS loads → "New in TIPS" popup
  reset();
  {
    // nothing new: one quiet request, no popup, no message
    log.length = 0;
    const e = makeEnv({ index: indexOf(topics), done: {} }, { autoCheck: true });
    await waitFor(() => e.st.lastCheck, 15000); await tick(150);
    ok(searches().length === 1 && searches()[0].order === 'desc', `on load: one quick search (${searches().length})`);
    ok(!e.note(), 'nothing new: no popup');
    await e.openBulk();
    ok(!/When TIPS loaded/.test(e.text()) && e.$('autock') && e.$('autock').checked, 'nothing new: no drawer message; switch "Check for new topics whenever TIPS loads" is on');

    // a new topic and a new version of an exported one → popup
    topics.push({ tips: 'LI54.30-P-080762', tipsId: 9003, version: 1, title: 'Rear camera image distorted after software update', modificationDate: iso(NOW + 3600e3) });
    const idx = indexOf(topics.slice(0, -1)), old = topics[2995];
    Object.assign(old, { version: old.version + 1, modificationDate: iso(NOW + 1800e3) });
    const done = Object.fromEntries(idx.map(x => [x.tipsId, { b: 1, d: 'x', v: x.version }]));
    const e2 = makeEnv({ index: idx, done }, { autoCheck: true });
    await waitFor(() => e2.note(), 15000);
    const t = e2.noteText();
    ok(/New in TIPS/.test(t) && /1 new topic and 1 new version since your last export · found when TIPS loaded at \d\d:\d\d/.test(t), 'popup: title and summary – ' + t.slice(0, 90));
    ok(/LI54\.30-P-080762\s*New.*Rear camera image distorted/.test(t) && new RegExp(`${old.tips.replace(/\./g, '\\.')}\\s*v${old.version - 1} → v${old.version}`).test(t) && /You exported v\d – v\d is queued again/.test(t), 'popup lists the new topic and the old → new version: ' + t);
    const links = [...e2.note().querySelectorAll('a.nr')].map(a => a.getAttribute('href'));
    ok(links.includes('/tips-reader/search/topics/9003/1'), 'each row opens the topic in TIPS');
    ok(e2.note().getAttribute('role') === 'dialog' && e2.note().getAttribute('aria-modal') === 'true' && e2.N('n_go') === e2.note().parentNode.activeElement, 'dialog semantics; focus on the main button');
    ok(/^Prepare 2 documents$/.test(e2.N('n_go').textContent.trim()) && !/batch/i.test(e2.noteText()), 'main button prepares the batch that holds them: ' + e2.N('n_go').textContent.trim());
    e2.w.dispatchEvent(new e2.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(20);
    ok(!e2.note(), 'Esc closes the popup');
    // Prepare batch from the popup (new topic; everything else exported)
    topics.push({ tips: 'LI35.31-P-080700', tipsId: 9005, version: 1, title: 'Prepare me', modificationDate: iso(NOW + 5400e3) });
    const idx3 = indexOf(topics.slice(0, -1));
    const e3 = makeEnv({ index: idx3, done: Object.fromEntries(idx3.map(x => [x.tipsId, { b: 1, d: 'x', v: x.version }])) }, { autoCheck: true });
    await waitFor(() => e3.note(), 15000);
    ok(/^Prepare 1 document$/.test(e3.N('n_go').textContent.trim()), 'single new topic: ' + e3.N('n_go').textContent.trim());
    e3.N('n_go').click();
    await waitFor(() => e3.$('approve'), 15000);
    ok(!e3.note() && /Batch 2 is ready/.test(e3.text()), 'Prepare batch: popup closes, drawer opens on Bulk export and the batch is prepared');
    e3.$('discard').click(); await tick(20);
    // switched off → no request
    log.length = 0;
    e3.$('autock').click(); await tick(20);
    ok(e3.st.settings.autoCheck === false, 'switch saves the setting');
    const e4 = makeEnv({ index: indexOf(topics), done: {} }, { autoCheck: false });
    await tick(3500);
    ok(searches().length === 0 && !e4.st.lastCheck && !e4.note(), 'switched off: no request, no popup');
    const e5 = makeEnv({ index: [] }, { autoCheck: true });
    await tick(3500);
    ok(searches().length === 0 && !e5.note() && !e5.root().querySelector('.dr'), 'no index: nothing happens');
    // the Cases list gets the popup too (it runs on any TIPS page)
    topics.push({ tips: 'LI82.60-P-080999', tipsId: 9004, version: 1, title: 'Cases page', modificationDate: iso(NOW + 9000e3) });
    const e6 = makeEnv({ index: indexOf(topics.slice(0, -1)), done: {} }, { autoCheck: true }, '/tips-reader/search/cases');
    await waitFor(() => e6.note(), 15000);
    ok(/LI82\.60-P-080999/.test(e6.noteText()) && !e6.w.document.querySelector('.tipsx-chk'), 'Cases list: popup shown, no button');
    e6.N('n_later').click(); await tick(20);
    ok(!e6.note(), 'Later closes it');
    // session expired on load: no popup, nothing breaks
    expire = true;
    const e7 = makeEnv({ index: indexOf(topics.slice(0, -1)), done: {} }, { autoCheck: true });
    await tick(3500); expire = false;
    ok(!e7.note() && !e7.root().querySelector('.dr'), 'expired session on load: quietly skipped');
  }

  // ---- 6. index without usable dates (mdate 0): stops at the first page with nothing new
  reset(false);
  {
    const idx = indexOf(topics).map(x => ({ ...x, mdate: 0 }));
    const e = makeEnv({ index: idx, done: {} });
    await tick(120);
    topics.push({ tips: 'LI82.60-P-080383', tipsId: 9100, version: 1, title: 'Radio', modificationDate: 2e12 });
    await e.openBulk();
    log.length = 0;
    e.$('refresh').click(); await waitFor(() => /appended at the end/.test(e.text()));
    ok(searches().length === 2 && e.st.index.length === 3001, `no dates: page 1 has the new topic, page 2 has nothing new → stop (${searches().length} requests)`);
  }
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
