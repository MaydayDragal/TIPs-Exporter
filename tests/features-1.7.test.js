// v1.7 features: path lengths, zip size cap, resume after a lost session, current search, update checks,
// search-result rows (download icon + tick boxes + selection bar), keyboard shortcut.
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');

const LONG = 'Customer complaint about intermittent loss of power steering assist while parking at low speed with ESP warning in the instrument cluster and additional fault codes stored in several control units';
const T = [
  { tips: 'LI42.10-P-078779', tipsId: 101, version: 5, title: 'Brake vibration from 60MPH – Diagnostic Guide' },
  { tips: 'LI46.10-P-070001', tipsId: 102, version: 2, title: LONG },
  { tips: 'LI54.10-P-080684', tipsId: 103, version: 3, title: 'Charging fault - P292900' },
  { tips: 'LI20.10-P-075374', tipsId: 104, version: 1, title: 'M256 Red coolant warning' }];
const byId = Object.fromEntries(T.map(t => [String(t.tipsId), t]));
let pdfKB = 8, expireOnce = null, bumped = {};
const log = [];
async function fakeFetch(url, init = {}) {
  const u = String(url);
  if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: 'o1' }) };
  if (u.includes('/topics/search')) {
    const b = JSON.parse(init.body); log.push({ kind: 'search', body: b });
    const cur = t => ({ ...t, version: bumped[t.tips] || t.version, modificationDate: 1 });
    let hits = b.docName ? T.filter(t => t.tips === b.docName) : b.searchText ? T.filter(t => /brake|steering|charging/i.test(t.title)) : T;
    const { pageNumber: p, pageSize: n } = b.pagination;
    return { ok: true, status: 200, json: async () => ({ totalHits: hits.length, hits: hits.slice((p - 1) * n, p * n).map(cur) }) };
  }
  let m = u.match(/\/file\/topics\/(\d+)\/(\d+)\?/);
  if (m) {
    if (expireOnce && expireOnce.id === m[1] && expireOnce.v === m[2]) { expireOnce = null; return { ok: false, status: 401 }; }
    log.push({ kind: 'pdf', id: m[1], v: m[2] });
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(pdfKB * 1024).buffer };
  }
  m = u.match(/\/topics\/(\d+)\/(\d+)\?/);
  if (m) {
    const t = byId[m[1]];
    const attachments = t.tipsId === 102 ? [{ attId: 1, filename: 'Wiring diagram for power steering control unit N68 with all connector pin assignments and ground points revision C.pdf', dataUrl: 'https://x/y?readKey=rk1', type: 'PDF' }] : [];
    return { ok: true, status: 200, json: async () => ({ version: +m[2], attachments, references: [], history: { children: [] } }) };
  }
  if (u.includes('/download/url')) return { ok: true, status: 200, json: async () => ({ url: 's3.example/f' }) };
  if (u.startsWith('https://s3.example/')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(1024).buffer };
  return { ok: false, status: 404 };
}
const cards = (list = T) => list.map(t => `<div class="xy-mb-1"><xy-c-card-table-card id="card-${t.tipsId}_${t.version}_P" class="xy-c-card-table-card"><button type="button" class="xy-c-card-table-card" style="width:900px">
  <div><div class="xy-grid"><xy-c-card-column><div><div><span><span><p>${t.tips}</p></span></span></div></div></xy-c-card-column>
  <xy-c-card-column><div><div><p class="xy-copy">${t.title}</p></div></div></xy-c-card-column><xy-c-card-column><p>9/21/26</p></xy-c-card-column><xy-c-card-column><p>All Models</p></xy-c-card-column></div></div></button></xy-c-card-table-card></div>`).join('');

function makeEnv(extra = {}, body = '', settings = {}) {
  const dom = new JSDOM(`<!doctype html><body>TIPS Reader v1.22.0 - 2026<xy-c-side-navigation><footer><xy-c-aux-menu id="auxMenu0"><div></div><button class="xy-test-standard-trigger"></button></xy-c-aux-menu></footer></xy-c-side-navigation><div class="xy-c-card-list-wrapper"><div>${body}</div></div></body>`,
    { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 50, delayMaxMs: 80, pageSize: 2, pageSizeSrc: 'detected', batchSize: 4, autoContinue: false, ...settings }, ...extra }, saved = [];
  w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = b => { saved.push({ blob: b }); return 'blob:x'; }; w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { saved[saved.length - 1].name = this.download; };
  w.chrome = { storage: { local: { get: async k => ({ [k]: st[k] }), set: async o => Object.assign(st, o) } }, runtime: { getManifest: () => ({ version: '1.7.0' }), onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true; w.fetch = fakeFetch;
  const pm = w.postMessage.bind(w);
  w.postMessage = (d, o) => { if (d && d.__tipsx) setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { data: d, source: w })), 0); else pm(d, o); };
  w.eval(probe); w.eval(content);
  const root = () => [...w.document.documentElement.children].find(e => e.shadowRoot).shadowRoot;
  const env = { w, st, saved, root, $: id => root().getElementById(id) };
  env.text = () => { const r = root().querySelector('.dr, .selbar'); if (!r) return ''; const tw = w.document.createTreeWalker(r, 4), a = []; while (tw.nextNode()) if (tw.currentNode.parentElement.tagName !== 'STYLE') a.push(tw.currentNode.textContent); return a.join(' ').replace(/\s+/g, ' '); };
  env.open = async () => { await tick(80); w.__toggle({ type: 'toggle' }, null, () => { }); await tick(30); };
  env.type = v => { const t = env.$('li'); t.value = v; t.dispatchEvent(new w.Event('input')); };
  return env;
}
async function unzip(w, blob) {
  const ab = await new Promise((res, rej) => { const fr = new w.FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsArrayBuffer(blob); });
  const buf = new Uint8Array(ab), dv = new DataView(buf.buffer), names = [];
  for (let o = 0; o + 30 <= buf.length && dv.getUint32(o, true) === 0x04034b50;) {
    const size = dv.getUint32(o + 18, true), nl = dv.getUint16(o + 26, true), xl = dv.getUint16(o + 28, true);
    names.push(new TextDecoder().decode(buf.slice(o + 30, o + 30 + nl))); o += 30 + nl + xl + size;
  }
  return names;
}
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(20); } }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const IDX = T.map(t => ({ tips: t.tips, tipsId: t.tipsId, version: t.version, title: t.title, mdate: 0 }));

(async () => {
  // ---- 2: path lengths
  {
    const e = makeEnv({ index: IDX });
    await e.open();
    e.type('LI46.10-P-070001'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
    e.$('dlfound').click(); await waitFor(() => /Saved to Downloads/.test(e.text()));
    const names = await unzip(e.w, e.saved.at(-1).blob), longest = Math.max(...names.map(n => n.length));
    console.log('     longest path in zip: ' + longest + ' chars · ' + names.find(n => n.includes('Attachments')));
    ok(names.every(n => n.split('/')[0].length <= 64) && longest <= 150, `zip paths stay short (longest ${longest} chars; folder ≤ 64)`);
    ok(names.some(n => /Attachments and Links\/Wiring diagram for power steering control unit N68[^/]*\.pdf$/.test(n) && n.split('/').pop().length <= 60), 'long attachment names are shortened and keep their .pdf extension');
  }
  // ---- 1: zip size cap (lowered to 1 MB for the test; 600 KB PDFs)
  {
    pdfKB = 150;
    const e = makeEnv({ index: IDX, done: {} }, '', { maxZipMB: 1 });
    await e.open(); e.$('tobulk').click(); await tick(20);
    e.$('prep').click(); await waitFor(() => e.$('approve'));
    ok(/reached 1 MB after 2 documents/.test(e.text()) && /other 2 stay pending/.test(e.text()), 'bulk batch stops at the size limit; the rest stay pending');
    e.$('approve').click(); await tick(50);
    ok(Object.keys(e.st.done).length === 2 && /Prepare batch 2 · 2 documents/.test(e.text()), 'next batch picks up the 2 that were left');
    e.$('tosingle').click(); await tick(20);
    e.type('LI42.10-P-078779 LI46.10-P-070001 LI54.10-P-080684 LI20.10-P-075374'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
    e.$('dlfound').click(); await waitFor(() => /Saved to Downloads/.test(e.text()));
    ok(/Documents 2 of 2/.test(e.text()) && /2 entries skipped/.test(e.text()) && /LI54\.10-P-080684 – Not downloaded – the zip reached 1 MB/.test(e.text()), 'single download stops at the limit and lists what was left out');
    e.$('fix').click(); await tick(20);
    ok(e.$('li').value === 'LI54.10-P-080684\nLI20.10-P-075374', 'Fix puts the left-out documents back in the box');
    pdfKB = 8;
  }
  // ---- 3: resume after a lost session (single + bulk)
  {
    const e = makeEnv({ index: IDX, done: {} });
    await e.open();
    e.type('LI42.10-P-078779 LI54.10-P-080684 LI20.10-P-075374'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
    expireOnce = { id: '103', v: '3' };
    e.$('dlfound').click(); await waitFor(() => e.$('resume'));
    ok(/Download interrupted – 1 of 3 done/.test(e.text()) && e.saved.length === 0, 'session lost mid-download: 1 of 3 kept, nothing saved yet, Resume offered');
    e.$('resume').click(); await waitFor(() => /Saved to Downloads/.test(e.text()));
    const names = await unzip(e.w, e.saved.at(-1).blob), pdfs = names.filter(n => n.endsWith('.pdf'));
    ok(pdfs.length === 9 && new Set(names.filter(n => n.includes("/")).map(n => n.split("/")[0])).size === 3 && new Set(names).size === names.length, `resumed: all 3 documents (with their 6 prior versions) in one zip, no duplicates (${pdfs.length} PDFs)`);
    e.$('tobulk').click(); await tick(20);
    expireOnce = { id: '102', v: '2' };
    e.$('prep').click(); await waitFor(() => e.$('resume'));
    ok(/Batch 1 interrupted – 1 of 4 done/.test(e.text()), 'bulk batch interrupted and kept');
    e.$('resume').click(); await waitFor(() => e.$('approve'));
    ok(/4 of 4/.test(e.text()), 'resumed batch completes with all 4 documents');
    e.$('discard').click(); await tick(20);
  }
  // ---- 4: download the Reader's current search
  {
    const e = makeEnv({ index: IDX });
    await tick(80);
    await e.w.fetch('/tips/topic-service/api/v1/topics/search?x', { method: 'POST', body: JSON.stringify({ searchText: 'brake', pagination: { pageNumber: 1, pageSize: 2 }, sortorder: { order: 'desc' } }) });
    await e.open();
    ok(/Your current TIPS search “brake”/.test(e.text()) && e.$('cursearch'), 'Single LI tab offers the current TIPS search');
    e.$('cursearch').click(); await waitFor(() => e.$('dlfound'));
    ok(/From your TIPS search “brake” : 3 topics/.test(e.text()) && /Download 3/.test(e.text()), 'the search\'s results are listed (3, across 2 pages)');
    const replay = log.filter(x => x.kind === 'search' && x.body.searchText === 'brake');
    ok(replay.length >= 2 && replay.every(x => x.body.pagination.pageSize === 2), 'replayed with the Reader\'s own filters and page size');
  }
  // ---- 5: newer versions of recent downloads
  {
    const e = makeEnv({ index: IDX });
    await e.open();
    e.type('LI42.10-P-078779'); e.$('look').click(); await waitFor(() => e.$('dlfound'));
    e.$('dlfound').click(); await waitFor(() => /Saved to Downloads/.test(e.text()));
    e.$('newdl').click(); await tick(20);
    bumped['LI42.10-P-078779'] = 6;
    e.$('rcheck').click(); await waitFor(() => /newer version in TIPS/.test(e.text()));
    ok(/Newer version in TIPS: LI42\.10-P-078779 v6 \(you have v5\)/.test(e.text()), 'Check for updates flags the newer version');
    e.root().querySelector('[data-upd]').click(); await waitFor(() => e.$('dlfound'));
    ok(/v6 · 5 prior/.test(e.text()), 'Download update looks up the new version');
    delete bumped['LI42.10-P-078779'];
  }
  // ---- 6: search-result rows
  {
    const e = makeEnv({ index: IDX }, cards());
    await tick(200);
    const rows = [...e.w.document.querySelectorAll('.tipsx-row')];
    ok(rows.length === 4 && rows.every(r => r.querySelector('.tipsx-rdl') && r.querySelector('input')), 'each result row gets a download icon and a tick box');
    ok(rows[0].parentElement.tagName === 'XY-C-CARD-TABLE-CARD' && rows[0].previousElementSibling.tagName === 'BUTTON', 'controls sit beside the row\'s button, not inside it');
    let rowClicked = 0; e.w.document.querySelectorAll('xy-c-card-table-card > button').forEach(b => b.addEventListener('click', () => rowClicked++));
    rows[0].querySelector('.tipsx-rdl').click();
    await waitFor(() => rows[0].querySelector('.tipsx-rdl').dataset.state === 'done');
    ok(e.saved.at(-1).name === 'TIPS_LI42.10-P-078779.zip' && rowClicked === 0, 'row download icon saves that topic without opening it');
    rows[1].querySelector('input').click(); rows[3].querySelector('input').click(); await tick(30);
    ok(/2 selected LI46\.10-P-070001, LI20\.10-P-075374/.test(e.text()) && e.$('seldl'), 'ticking rows shows the selection bar');
    ok(rows[1].parentElement.classList.contains('tipsx-picked'), 'ticked rows are marked');
    e.$('seldl').click();
    await waitFor(() => /Saved to Downloads/.test(e.text()));
    ok(/TIPS_selection_.*_2docs\.zip/.test(e.saved.at(-1).name) && !e.w.document.querySelector('.tipsx-row input:checked'), 'Download 2 opens the drawer, saves both, clears the ticks');
    // lazy list: new cards get controls, ticks survive re-render
    e.w.document.querySelector('.xy-c-card-list-wrapper > div').insertAdjacentHTML('beforeend', `<div><xy-c-card-table-card id="card-105_1_P"><button><xy-c-card-column><p>LI82.60-P-080383</p></xy-c-card-column><xy-c-card-column><p>Radio cover art</p></xy-c-card-column></button></xy-c-card-table-card></div>`);
    await tick(100);
    ok(!!e.w.document.querySelector('#card-105_1_P > .tipsx-row'), 'rows loaded later (scrolling) get controls too');
  }
  // ---- 6b: selection follows the list order (not TIPS's internal ids); the last row can scroll clear of the bar
  {
    const e = makeEnv({ index: IDX }, cards([...T].reverse()));
    await tick(200);
    const rows = [...e.w.document.querySelectorAll('.tipsx-row')], last = rows.at(-1).parentElement;
    ok(!last.classList.contains('tipsx-lastpad'), 'no extra space below the list while nothing is ticked');
    rows[2].querySelector('input').click(); rows[0].querySelector('input').click(); await tick(30);
    ok(/2 selected LI20\.10-P-075374, LI46\.10-P-070001/.test(e.text()), 'selection bar lists topics in the order they appear on the page');
    ok(last.classList.contains('tipsx-lastpad') && e.w.document.querySelectorAll('.tipsx-lastpad').length === 1, 'last row gets space below it while the bar shows');
    e.$('selclear').click(); await tick(30);
    ok(!e.w.document.querySelector('.tipsx-lastpad') && !e.$('seldl'), 'Clear removes the bar and the extra space');
    rows[2].querySelector('input').click(); rows[0].querySelector('input').click(); await tick(30);
    e.$('seldl').click(); await waitFor(() => /Saved to Downloads/.test(e.text()));
    const tops = [...new Set((await unzip(e.w, e.saved.at(-1).blob)).filter(n => n.includes('/')).map(n => n.split('/')[0].slice(0, 16)))];
    ok(tops.join(' ') === 'LI20.10-P-075374 LI46.10-P-070001', 'the zip keeps the page order too');
  }
  // ---- 7: keyboard shortcut
  const man = JSON.parse(fs.readFileSync(SRC + 'manifest.json', 'utf8'));
  ok(man.commands && man.commands._execute_action && man.commands._execute_action.suggested_key.default === 'Alt+Shift+E', 'Alt+Shift+E opens and closes the drawer');
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
