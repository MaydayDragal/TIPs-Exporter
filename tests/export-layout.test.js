// Exercise the real UI -> export -> ZIP path against the user's example layout.
// Network and Chrome storage are simulated; PDFs use real document fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const {makePdf,installPdfFixtures} = require('./helpers/pdf-fixture');
const L = require('../vendor/pdf-lib.min.js');
async function pdfText(bytes) { const d=await L.PDFDocument.load(bytes); return d.context.enumerateIndirectObjects().filter(([,o])=>o instanceof L.PDFRawStream).map(([,o])=>Buffer.from(L.decodePDFRawStream(o).decode()).toString('latin1')).join('\n'); }
const code = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const ITEM = { tips: 'LI00.00-P-066047', tipsId: 101, version: 7, title: 'Odor like crayon or vinegar entering the passenger compartment' };
const BASE = 'LI00.00-P-066047 - Odor like crayon or vinegar entering the pass (Requested)';
const ALL = { docJson: true, histCsv: true, histJson: true, attCsv: true, manifest: true };
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 6000; while (!fn()) { if (Date.now() > end) throw Error('Timed out'); await tick(10); } }
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }
async function entries(blob) {
  const ab = await blob.arrayBuffer(), b = new Uint8Array(ab), v = new DataView(ab), result = new Map();
  for (let o = 0; o + 30 < b.length && v.getUint32(o, true) === 0x04034b50;) {
    const size = v.getUint32(o + 18, true), n = v.getUint16(o + 26, true), x = v.getUint16(o + 28, true), start = o + 30 + n + x;
    const name = new TextDecoder().decode(b.slice(o + 30, o + 30 + n));
    assert(!result.has(name), 'Duplicate ZIP entry: ' + name);
    result.set(name, b.slice(start, start + size));
    o = start + size;
  }
  return result;
}
async function env({ item = ITEM, state, idb = new IDBFactory(), settings = {}, expirePrior = false } = {}) {
  const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', {
    url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window, saved = [], st = state || { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0',
    delayMs: 0, delayMaxMs: 0, autoContinue: false, autoCheck: false, pdfScrub: { enabled: false }, ...settings }, index: [item] };
  Object.assign(w, { TextEncoder, TextDecoder, Blob, indexedDB: idb });
  w.URL.createObjectURL = blob => { saved.push({ blob }); return 'blob:test'; }; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { saved.at(-1).name = this.download; };
  w.chrome = { storage: { local: { get: async k => ({ [k]: structuredClone(st[k]) }), set: async x => Object.assign(st, structuredClone(x)) } },
    runtime: { onMessage: { addListener(fn) { w.toggle = fn; } } } };
  const json = data => ({ ok: true, status: 200, json: async () => data });
  const bytes = s => ({ ok: true, status: 200, arrayBuffer: async () => (typeof s === 'string' ? new TextEncoder().encode(s) : s).slice().buffer });
  let expired = false;
  w.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/currentuser')) return json({ userId: 'u1', currentOutlet: 'o1' });
    if (u.includes('/topics/search')) return json({ totalHits: 1, hits: [item] });
    const m = u.match(/\/file\/topics\/101\/(\d+)\?/);
    if (m) {
      if (expirePrior && !expired && m[1] === '1') { expired = true; return { ok: false, status: 401 }; }
      return bytes(await makePdf('Version ' + m[1]));
    }
    if (u.includes('/topics/101/')) return json({ version: item.version, attachments: [
      { attId: 1, filename: 'workshop instruction_EN.pdf', type: 'PDF', dataUrl: 'https://example.test/?readKey=one' }
    ], references: [], history: { children: [] } });
    if (u.includes('/download/url')) return json({ url: 'https://example.test/download/one' });
    if (u === 'https://example.test/download/one') return bytes(await makePdf('Workshop instruction'));
    throw Error('Unexpected test request: ' + u);
  };
  installPdfFixtures(w);
  w.eval(fs.readFileSync(require('path').join(__dirname, '..', 'index-csv.js'), 'utf8')); w.eval(code);
  const root = () => [...w.document.documentElement.children].find(e => e.shadowRoot)?.shadowRoot;
  const $ = id => root()?.getElementById(id);
  await tick(80); w.toggle({ type: 'toggle' }, null, () => {}); await until(() => $('li') || $('approve') || $('resume'));
  return { w, st, saved, $, root, idb, async start() {
    $('li').value = item.tips; $('li').dispatchEvent(new w.Event('input')); $('look').click();
    await until(() => $('dlfound')); $('dlfound').click();
  }, async download() { await this.start(); await until(() => saved.length); return entries(saved.at(-1).blob); } };
}

(async () => {
  // Catches putting prior PDFs in a separate folder, extra default data files, or missing attachment grouping.
  await test('default single ZIP matches the supplied folder and filename layout', async () => {
    const e = await env(), files = await e.download();
    assert.equal(e.saved[0].name, 'LI00.00-P-066047 - Odor like crayon or vinegar entering the pass.zip');
    assert.deepEqual([...files.keys()], [
      BASE + '/', BASE + '/Attachments and Links/', BASE + '/Attachments and Links/workshop instruction_EN.pdf',
      BASE + '/LI00.00-P-066047_v1.pdf', BASE + '/LI00.00-P-066047_v2.pdf', BASE + '/LI00.00-P-066047_v3.pdf',
      BASE + '/LI00.00-P-066047_v4.pdf', BASE + '/LI00.00-P-066047_v5.pdf', BASE + '/LI00.00-P-066047_v6.pdf', BASE + '/LI00.00-P-066047_v7.pdf'
    ]);
    assert((await pdfText(files.get(BASE + '/LI00.00-P-066047_v1.pdf'))).includes('Version 1'));
  });
  // Lexicographic sorting wrongly puts v10 before v2; preserve every version and its bytes.
  await test('PDF versions stay in numeric order through double digits', async () => {
    const e = await env({ item: { ...ITEM, version: 12 } }), files = await e.download();
    assert.deepEqual([...files.keys()].filter(n => /_v\d+\.pdf$/.test(n)).map(n => n.match(/_v(\d+)\.pdf$/)[1]),
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    assert((await pdfText(files.get(BASE + '/LI00.00-P-066047_v12.pdf'))).includes('Version 12'));
  });
  await test('bulk uses the same topic layout and retains its resumable progress log', async () => {
    const e = await env(); e.$('tobulk').click(); e.$('prep').click(); await until(() => e.$('approve'));
    e.$('approve').click(); await until(() => e.saved.length); const files = await entries(e.saved[0].blob);
    assert(files.has(BASE + '/LI00.00-P-066047_v1.pdf'));
    assert(files.has(BASE + '/LI00.00-P-066047_v7.pdf'));
    assert(files.has('_progress_log_all_documents.csv')); assert(!files.has('_batch_001_manifest.csv'));
    await until(() => e.st.done?.[101]); assert.equal(e.st.done[101].v, 7);
  });
  await test('upgrade replaces the old all-data default and an explicit later choice survives reload', async () => {
    const e = await env({ settings: { files: ALL } });
    const first = await e.download(); assert(![...first.keys()].some(n => /\.(csv|json)$/.test(n)));
    e.$('gear').click(); e.$('f_all').click(); await until(() => e.st.settings.files.docJson);
    const reloaded = await env({ state: structuredClone(e.st) }), files = await reloaded.download();
    assert(files.has(BASE + '/LI00.00-P-066047_v7.json'));
    assert(files.has(BASE + '/Revision History/revision_history.csv'));
    assert(files.has(BASE + '/Attachments and Links/_attachments_and_links.csv'));
    assert(files.has('_manifest.csv')); assert(files.has(BASE + '/LI00.00-P-066047_v1.pdf'));
  });
  await test('session resume saves one complete ordered ZIP without duplicate versions', async () => {
    const e = await env({ expirePrior: true }); await e.start(); await until(() => e.$('resume'));
    e.$('resume').click(); await until(() => e.saved.length); const files = await entries(e.saved[0].blob);
    assert.equal(files.size, 10); assert(files.has(BASE + '/LI00.00-P-066047_v1.pdf'));
    assert.deepEqual([...files.keys()].filter(n => /_v\d+\.pdf$/.test(n)).map(n => n.match(/_v(\d+)/)[1]), ['1','2','3','4','5','6','7']);
  });
  await test('a prepared ZIP from the previous layout must be rebuilt without losing export progress', async () => {
    const idb = new IDBFactory(), q = idb.open('tips-exporter', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv');
    const db = await new Promise((resolve, reject) => { q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    await new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put({ kind: 'batch', n: 2, fname: 'TIPS_LI_Batch_002.zip', buf: new ArrayBuffer(30), results: [],
        pdfPolicy: {enabled:true,timestamp:true,strings:['D7MASALL','u1'],requiredCleanup:1},
        summary: { fname: 'TIPS_LI_Batch_002.zip', sizeMB: 1, docs: 0, ok: 0, inc: 0, att: 0, prev: 0, range: '', errors: [] } }, 'pending');
      t.oncomplete = resolve; t.onerror = () => reject(t.error);
    });
    const state = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', autoCheck: false, pdfScrub: { enabled: false } },
      index: [ITEM], done: { 999: { b: 1, v: 2, d: '2026-10-07' } } };
    const e = await env({ idb, state });
    assert(!e.$('approve')); assert.equal(e.saved.length, 0); assert.equal(e.st.done[999].v, 2);
    assert(/layout.*Prepare it again/i.test(e.root().textContent)); db.close();
  });
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('ERROR ' + e.stack); process.exit(1); });
