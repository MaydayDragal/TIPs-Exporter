// Real PDF bytes and the real export/ZIP path; only TIPS/network and Chrome storage are simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const ROOT = path.join(__dirname, '..');
const vendor = path.join(ROOT, 'vendor/pdf-lib.min.js');
const L = require(fs.existsSync(vendor) ? vendor : require.resolve('pdf-lib', { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES] }));
const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = L;
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 6000; while (!fn()) { if (Date.now() > end) throw Error('Timed out'); await tick(10); } }
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }

async function fixture() {
  const d = await PDFDocument.create();
  d.setAuthor('D7MASALL'); d.setTitle('Private title'); d.setProducer('Private producer');
  const c = d.context, N = PDFName.of;
  const font = c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  const resources = c.obj({ Font: { F1: font } });
  const form = c.register(c.flateStream('BT /F1 10 Tf 20 40 Td (D7MASALL) Tj ET', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 200], Resources: resources
  }));
  const p = d.addPage([300, 200]);
  p.node.set(N('Resources'), c.obj({ Font: { F1: font }, XObject: { Footer: form } }));
  p.node.set(N('Contents'), c.obj([
    c.register(c.flateStream('q BT /F1 11 Tf 20 160 Td (Diagnostic body) Tj ET')),
    c.register(c.flateStream('BT /F1 9 Tf 20 30 Td (02-10-2026 13:55:18) Tj ET BT /F1 9 Tf 130 30 Td [<44374D4153414C4C>] TJ ET')),
    c.register(c.flateStream('BT /F1 9 Tf 20 70 Td (AUTOUSER) Tj ET BT /F1 9 Tf 230 30 Td (Page 1 / 1) Tj ET BT /F1 8 Tf 20 15 Td (Copyright Mercedes-Benz AG) Tj ET /Footer Do Q'))
  ]));
  d.catalog.set(N('Metadata'), c.register(c.flateStream('<xml>D7MASALL</xml>', { Type: 'Metadata', Subtype: 'XML' })));
  p.node.set(N('PieceInfo'), c.obj({ Private: 'D7MASALL' }));
  c.trailerInfo.ID = c.obj([L.PDFHexString.of('AABB'), L.PDFHexString.of('AABB')]);
  c.register(c.flateStream('D7MASALL old unreachable content'));
  return d.save({ useObjectStreams: false });
}
async function inspect(bytes) {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  let streams = '';
  for (const [, obj] of d.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) streams += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1') + '\n';
  }
  return { d, streams };
}
async function assertClean(bytes) {
  const { d, streams } = await inspect(bytes);
  assert.equal(d.getPageCount(), 1);
  assert.equal(d.context.trailerInfo.Info, undefined);
  assert.equal(d.context.trailerInfo.ID, undefined);
  assert.equal(d.catalog.get(PDFName.of('Metadata')), undefined);
  assert.equal(d.getPages()[0].node.get(PDFName.of('PieceInfo')), undefined);
  assert(!/D7MASALL|44374D4153414C4C|AUTOUSER|02-10-2026/.test(streams), 'matched text must be removed from all saved content streams');
  assert(streams.includes('Diagnostic body'));
  assert(streams.includes('Page 1 / 1'));
  assert(streams.includes('Copyright Mercedes-Benz AG'));
}
function unzip(blob) {
  return blob.arrayBuffer().then(ab => {
    const b = new Uint8Array(ab), v = new DataView(ab), files = new Map();
    for (let o = 0; o + 30 < b.length && v.getUint32(o, true) === 0x04034b50;) {
      const size = v.getUint32(o + 18, true), n = v.getUint16(o + 26, true), x = v.getUint16(o + 28, true);
      const start = o + 30 + n + x;
      files.set(new TextDecoder().decode(b.slice(o + 30, o + 30 + n)), b.slice(start, start + size));
      o = start + size;
    }
    return files;
  });
}
const ITEM = { tips: 'LI42.10-P-078779', tipsId: 101, version: 2, title: 'Test document', mdate: 1 };
async function env(pdf, { scrub, missingEngine = false, idb = new IDBFactory(), state, expirePrior = false } = {}) {
  const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', {
    url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window, saved = [], st = state || { settings: { outlet: 'o1', user: 'AUTOUSER', ver: '1.22.0',
    delayMs: 0, delayMaxMs: 0, autoContinue: false, autoCheck: false, ...(scrub ? { pdfScrub: scrub } : {}) }, index: [ITEM] };
  Object.assign(w, { TextEncoder, TextDecoder, Blob, Response, CompressionStream, indexedDB: idb });
  w.URL.createObjectURL = blob => { saved.push({ blob }); return 'blob:test'; }; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { saved.at(-1).name = this.download; };
  w.chrome = { storage: { local: { get: async k => ({ [k]: structuredClone(st[k]) }), set: async x => Object.assign(st, structuredClone(x)) } },
    runtime: { getManifest: () => ({ version: '1.13.0' }), onMessage: { addListener(fn) { w.toggle = fn; } } } };
  const bytes = (b, type = 'application/pdf') => ({ ok: true, status: 200, headers: { get: () => type }, arrayBuffer: async () => w.Uint8Array.from(b).buffer });
  const json = data => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data });
  let expired = false;
  w.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/currentuser')) return json({ userId: 'AUTOUSER', currentOutlet: 'o1' });
    if (u.includes('/topics/search')) return json({ totalHits: 1, hits: [ITEM] });
    if (u.includes('/file/topics/')) {
      if (expirePrior && !expired && /\/101\/1\?/.test(u)) { expired = true; return { ok: false, status: 401 }; }
      return bytes(pdf);
    }
    if (/\/topics\/101\/[12]\?/.test(u)) return json({ version: 2, attachments: [
      { attId: 1, filename: 'document.PDF', type: 'PDF', dataUrl: 'https://example.test/?readKey=pdf' },
      { attId: 2, filename: 'no-extension', type: 'file', dataUrl: 'https://example.test/?readKey=magic' },
      { attId: 3, filename: 'note.txt', type: 'file', dataUrl: 'https://example.test/?readKey=text' }
    ], references: [], history: { children: [] } });
    if (u.includes('/download/url')) return json({ url: 'https://example.test/download/' + new URL(u, w.location.origin).searchParams.get('readKey') });
    if (u.endsWith('/text')) return bytes(new TextEncoder().encode('Original non-PDF attachment'), 'text/plain');
    if (u.endsWith('/magic')) return bytes(pdf, 'application/octet-stream');
    if (u.endsWith('/pdf')) return bytes(pdf);
    throw new Error('Unexpected test request: ' + u);
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json')));
  for (const script of manifest.content_scripts.filter(s => s.world !== 'MAIN').flatMap(s => s.js)) {
    if (!missingEngine || !/pdf-scrub/.test(script)) w.eval(fs.readFileSync(path.join(ROOT, script), 'utf8'));
  }
  const root = () => [...w.document.documentElement.children].find(e => e.shadowRoot)?.shadowRoot;
  const $ = id => root()?.getElementById(id);
  await tick(100); w.toggle({ type: 'toggle' }, null, () => {}); await tick(20);
  // Like the existing suites, exit after checks: the extension owns long-lived timers/observers.
  return { w, st, saved, $, root, idb, close: () => {}, async download() {
    $('li').value = ITEM.tips; $('li').dispatchEvent(new w.Event('input')); $('look').click();
    await until(() => $('dlfound')); $('dlfound').click(); await until(() => saved.length); return unzip(saved.at(-1).blob);
  } };
}

(async () => {
  const original = await fixture();
  await test('single export strips current, prior, PDF attachment and magic-detected PDF before ZIP', async () => {
    const e = await env(original);
    try {
      const files = await e.download(), pdfs = [...files].filter(([n]) => /\.pdf$/i.test(n) || n.endsWith('/no-extension'));
      assert.equal(pdfs.length, 4);
      for (const [, data] of pdfs) await assertClean(data);
      assert.equal(new TextDecoder().decode([...files].find(([n]) => n.endsWith('/note.txt'))[1]), 'Original non-PDF attachment');
      assert(/PDFs scrubbed/.test(e.root().textContent));
    } finally { e.close(); }
  });
  await test('bulk preparation persists only cleaned PDFs and approval marks successful documents', async () => {
    const e = await env(original);
    try {
      e.$('tobulk').click(); e.$('prep').click(); await until(() => e.$('approve'));
      e.$('approve').click(); await until(() => e.saved.length);
      const files = await unzip(e.saved[0].blob);
      for (const [n, data] of files) if (/\.pdf$/i.test(n)) await assertClean(data);
      await until(() => e.st.done && e.st.done[101]);
      assert.equal(e.st.done[101].v, 2);
    } finally { e.close(); }
  });
  await test('scrub failure omits original PDFs, records errors and leaves bulk topic pending', async () => {
    const e = await env(new TextEncoder().encode('%PDF-invalid UNSCRUBBED-SECRET'));
    try {
      e.$('tobulk').click(); e.$('prep').click(); await until(() => e.$('approve'));
      e.$('approve').click(); await until(() => e.saved.length); await tick(40);
      const files = await unzip(e.saved[0].blob);
      assert(![...files.keys()].some(n => /\.pdf$/i.test(n) || n.endsWith('/no-extension')));
      const errors = new TextDecoder().decode(files.get('_batch_001_errors.txt'));
      assert(/PDF scrub failed/.test(errors)); assert(!errors.includes('UNSCRUBBED-SECRET'));
      assert(!e.st.done?.[101]);
    } finally { e.close(); }
  });
  await test('missing scrub engine fails closed for PDFs while keeping non-PDF attachments', async () => {
    const e = await env(original, { missingEngine: true });
    try {
      const files = await e.download();
      assert(![...files.keys()].some(n => /\.pdf$/i.test(n)));
      assert([...files.keys()].some(n => n.endsWith('/note.txt')));
      assert(/PDF scrub failed/.test(new TextDecoder().decode(files.get('_errors.txt'))));
    } finally { e.close(); }
  });
  await test('old disabled preference cannot bypass required PDF cleanup', async () => {
    const e = await env(original, { scrub: { enabled: false } });
    try { const files = await e.download(); for (const [n, b] of files) if (/\.pdf$/i.test(n)) await assertClean(b); }
    finally { e.close(); }
  });
  await test('custom and optional user rules persist while required timestamps stay enabled', async () => {
    const e = await env(original);
    try {
      e.$('gear').click();
      assert(e.$('s_pdfEnabled')?.checked, 'PDF scrubbing should be enabled by default');
      const input = e.$('s_pdfStrings'); input.value = 'CUSTOM, SECOND\nTHIRD'; input.dispatchEvent(new e.w.Event('input'));
      e.$('s_pdfTimestamp').click();
      assert.equal(e.$('s_pdfStrings').value, 'CUSTOM, SECOND\nTHIRD');
      e.$('s_pdfUser').click(); e.$('s_save').click(); await tick(30);
      assert.equal(e.st.settings.pdfScrub.strings, 'CUSTOM, SECOND\nTHIRD');
      assert.equal(e.st.settings.pdfScrub.timestamp, true); assert.equal(e.st.settings.pdfScrub.user, false);
    } finally { e.close(); }
  });
  await test('optional user cleanup can be disabled while fixed ID, timestamp and metadata cleanup remains', async () => {
    const e = await env(original, { scrub: { enabled: true, user: false, timestamp: false, strings: '' } });
    try {
      const files = await e.download(), { d, streams } = await inspect([...files].find(([n]) => /_v2\.pdf$/.test(n))[1]);
      assert.equal(d.context.trailerInfo.Info, undefined); assert.equal(d.context.trailerInfo.ID, undefined);
      assert.equal(d.catalog.get(PDFName.of('Metadata')), undefined);
      assert(streams.includes('AUTOUSER')); assert(!streams.includes('02-10-2026')); assert(!streams.includes('D7MASALL') && !streams.includes('44374D4153414C4C'));
    } finally { e.close(); }
  });
  await test('session interruption resumes through the same PDF scrub path', async () => {
    const e = await env(original, { expirePrior: true });
    try {
      e.$('li').value = ITEM.tips; e.$('li').dispatchEvent(new e.w.Event('input')); e.$('look').click();
      await until(() => e.$('dlfound')); e.$('dlfound').click(); await until(() => e.$('resume'));
      assert.equal(e.saved.length, 0); e.$('resume').click(); await until(() => e.saved.length);
      for (const [n, data] of await unzip(e.saved[0].blob)) if (/\.pdf$/i.test(n)) await assertClean(data);
    } finally { e.close(); }
  });
  await test('session User and scrub rules cannot change during an active single export', async () => {
    const e = await env(original);
    let release;
    const gate = new Promise(r => { release = r; });
    const realScrub = e.w.TIPSPdfScrubber.scrub;
    e.w.TIPSPdfScrubber.scrub = async (...args) => { await gate; return realScrub(...args); };
    try {
      e.$('li').value = ITEM.tips; e.$('li').dispatchEvent(new e.w.Event('input')); e.$('look').click();
      await until(() => e.$('dlfound')); e.$('dlfound').click(); await until(() => e.$('cancel'));
      e.$('gear').click();
      assert(e.$('s_user').disabled, 'User must be locked while requests use the frozen scrub rules');
      assert(e.$('s_detect').disabled); assert(e.$('s_pdfEnabled').disabled);
      e.$('s_user').value = 'NEWUSER'; e.$('s_save').click(); await tick(20);
      assert.equal(e.st.settings.user, 'AUTOUSER');
      release(); await until(() => e.saved.length);
      for (const [n, data] of await unzip(e.saved[0].blob)) if (/\.pdf$/i.test(n)) await assertClean(data);
    } finally { release(); e.close(); }
  });
  await test('prepared scrubbed batch survives reload with its policy and clean PDF bytes', async () => {
    const e = await env(original);
    try {
      e.$('tobulk').click(); e.$('prep').click(); await until(() => e.$('approve')); await tick(50);
      const restored = await env(original, { idb: e.idb, state: structuredClone(e.st) });
      assert(restored.$('approve')); restored.$('approve').click(); await until(() => restored.saved.length);
      for (const [n, data] of await unzip(restored.saved[0].blob)) if (/\.pdf$/i.test(n)) await assertClean(data);
    } finally { e.close(); }
  });
  await test('an old unprocessed prepared batch is rejected after automatic scrubbing is enabled', async () => {
    const e = await env(original, { scrub: { enabled: false } });
    try {
      e.$('tobulk').click(); e.$('prep').click(); await until(() => e.$('approve')); await tick(50);
      // Model a ZIP cached by an earlier extension, with the pre-mandatory policy.
      const db = await new Promise((resolve,reject)=>{const q=e.idb.open('tips-exporter',1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      await new Promise((resolve,reject)=>{const tx=db.transaction('kv','readwrite'),kv=tx.objectStore('kv'),q=kv.get('pending');q.onsuccess=()=>kv.put({...q.result,pdfPolicy:{enabled:false}},'pending');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);}); db.close();
      const state = structuredClone(e.st); delete state.settings.pdfScrub;
      const restored = await env(original, { idb: e.idb, state });
      assert(!restored.$('approve')); assert.equal(restored.saved.length, 0);
      assert(/Prepare it again/.test(restored.root().textContent)); assert(!restored.st.done?.[101]);
    } finally { e.close(); }
  });
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('ERROR ' + e.stack); process.exit(1); });
