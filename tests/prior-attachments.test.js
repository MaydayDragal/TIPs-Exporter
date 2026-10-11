// Attachments that a later revision removed are only listed in older versions' topic data.
// Covers ZIP exports, the documents-folder sync (incremental + one-time catch-up) and the setting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const { installPdfFixtures, makePdf } = require('./helpers/pdf-fixture');
const D = require('./helpers/documents-env');
const Client = require('../documents-client');
const code = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label = 'condition') { const end = Date.now() + 8000; while (!fn()) { if (Date.now() > end) throw Error('Timed out: ' + label); await tick(10); } }
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
async function entries(blob) {
  const ab = await blob.arrayBuffer(), b = new Uint8Array(ab), v = new DataView(ab), result = new Map();
  for (let o = 0; o + 30 < b.length && v.getUint32(o, true) === 0x04034b50;) {
    const size = v.getUint32(o + 18, true), n = v.getUint16(o + 26, true), x = v.getUint16(o + 28, true), start = o + 30 + n + x;
    result.set(new TextDecoder().decode(b.slice(o + 30, o + 30 + n)), b.slice(start, start + size)); o = start + size;
  }
  return result;
}
const att = (attId, filename, key) => ({ attId, filename, type: 'C', dataUrl: `https://xentry.mercedes-benz.com/ats/public/attachment/v1/read/download/redirect?readKey=${key}` });
// v1–v2 carried photos that v3 dropped; v3 has its own, different photo.png.
const VERSIONS = {
  1: [att(10, 'photo.png', 'a'), att(12, 'diagram.png', 'c')],
  2: [att(10, 'photo.png', 'a'), att(11, 'Filter Go_No Go.PNG', 'b')],
  3: [att(13, 'photo.png', 'd')]
};
const BYTES = { a: 'old photo', b: 'filter photo', c: 'diagram', d: 'new photo' };
const ITEM = { tips: 'LI20.10-P-076206', tipsId: 242202917, version: 3, title: 'Various CELs related to coolant temperature' };
const BASE = 'LI20.10-P-076206 - Various CELs related to coolant temperature (Requested)';

async function zipEnv({ settings = {}, versions = VERSIONS, fail = {} } = {}) {
  const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, saved = [], requests = [];
  const st = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 0, delayMaxMs: 0, autoContinue: false, autoCheck: false, pdfScrub: { enabled: false }, ...settings }, index: [ITEM] };
  Object.assign(w, { TextEncoder, TextDecoder, Blob, indexedDB: new IDBFactory() });
  w.URL.createObjectURL = blob => { saved.push({ blob }); return 'blob:test'; }; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { saved.at(-1).name = this.download; };
  w.chrome = { storage: { local: { get: async k => ({ [k]: structuredClone(st[k]) }), set: async x => Object.assign(st, structuredClone(x)) } }, runtime: { onMessage: { addListener(fn) { w.toggle = fn; } } } };
  const json = data => ({ ok: true, status: 200, json: async () => data });
  const bytes = s => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new TextEncoder().encode(s).buffer });
  w.fetch = async url => {
    const u = String(url); requests.push(u);
    if (u.includes('/currentuser')) return json({ userId: 'u1', currentOutlet: 'o1' });
    if (u.includes('/topics/search')) return json({ totalHits: 1, hits: [ITEM] });
    let m = u.match(/\/file\/topics\/242202917\/(\d+)\?/);
    if (m) return { ok: true, status: 200, arrayBuffer: async () => (await makePdf('Version ' + m[1])).slice().buffer };
    m = u.match(/\/topics\/242202917\/(\d+)\?/);
    if (m) { if (fail[m[1]]) return { ok: false, status: fail[m[1]] }; return json({ version: 3, attachments: versions[m[1]] || [], references: [], history: { children: [] } }); }
    m = u.match(/download\/url\?readKey=(\w+)/); if (m) return json({ url: 'https://s3.test/' + m[1] });
    m = u.match(/^https:\/\/s3\.test\/(\w+)$/); if (m) return bytes(BYTES[m[1]]);
    throw Error('Unexpected test request: ' + u);
  };
  installPdfFixtures(w);
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'index-csv.js'), 'utf8')); w.eval(code);
  const root = () => [...w.document.documentElement.children].find(e => e.shadowRoot)?.shadowRoot;
  const $ = id => root()?.getElementById(id);
  await tick(80); w.toggle({ type: 'toggle' }, null, () => {}); await until(() => $('li'));
  return { w, st, saved, requests, $, root, async download() {
    $('li').value = ITEM.tips; $('li').dispatchEvent(new w.Event('input')); $('look').click();
    await until(() => $('dlfound')); $('dlfound').click(); await until(() => saved.length, 'zip'); return entries(saved.at(-1).blob);
  } };
}
const text = b => new TextDecoder().decode(b);

(async () => {
  await test('ZIP keeps photos that only earlier versions listed, once each, beside the current ones', async () => {
    const e = await zipEnv(), files = await e.download(), A = BASE + '/Attachments and Links/';
    assert.equal(text(files.get(A + 'photo.png')), 'new photo', 'the current attachment keeps its own name');
    assert.equal(text(files.get(A + 'photo (v2).png')), 'old photo', 'a clashing earlier file is named after the last version that had it');
    assert.equal(text(files.get(A + 'Filter Go_No Go.PNG')), 'filter photo');
    assert.equal(text(files.get(A + 'diagram.png')), 'diagram');
    assert.equal([...files.keys()].filter(n => n.startsWith(A) && !n.endsWith('/')).length, 4, 'attachment 10 appears in v1 and v2 but is saved once');
    assert.equal(e.requests.filter(u => /download\/url\?readKey=a/.test(u)).length, 1);
    assert(files.has(BASE + '/LI20.10-P-076206_v1.pdf') && files.has(BASE + '/LI20.10-P-076206_v3.pdf'));
  });
  await test('a current version without attachments still gets the earlier photos (the reported LI case)', async () => {
    const e = await zipEnv({ versions: { 1: VERSIONS[1], 2: VERSIONS[2], 3: [] } }), files = await e.download(), A = BASE + '/Attachments and Links/';
    assert.equal(text(files.get(A + 'photo.png')), 'old photo');
    assert.equal(text(files.get(A + 'Filter Go_No Go.PNG')), 'filter photo');
    assert.equal(text(files.get(A + 'diagram.png')), 'diagram');
  });
  await test('links CSV marks which versions an earlier attachment belonged to', async () => {
    const e = await zipEnv({ settings: { outputLayout: 1, files: { attCsv: true } } }), files = await e.download();
    const csv = text(files.get(BASE + '/Attachments and Links/_attachments_and_links.csv'));
    assert.match(csv, /"C \(v1-v2 only\)","photo \(v2\)\.png"/); assert.match(csv, /"C \(v2 only\)","Filter Go_No Go\.PNG"/); assert.match(csv, /"C \(v1 only\)","diagram\.png"/);
  });
  await test('turning the setting off restores current-only attachments with no extra requests', async () => {
    const e = await zipEnv({ settings: { priorAttachments: false } }), files = await e.download();
    assert.deepEqual([...files.keys()].filter(n => n.includes('/Attachments and Links/') && !n.endsWith('/')), [BASE + '/Attachments and Links/photo.png']);
    assert.equal(e.requests.filter(u => /\/api\/v1\/topics\/242202917\/[12]\?/.test(u)).length, 0);
  });
  await test('an earlier version missing from TIPS is skipped without failing the document', async () => {
    const e = await zipEnv({ fail: { 1: 404 } }), files = await e.download(), A = BASE + '/Attachments and Links/';
    assert(files.has(A + 'Filter Go_No Go.PNG') && files.has(A + 'photo (v2).png') && !files.has(A + 'diagram.png'));
    assert(!files.has('_errors.txt'), 'a gone version is not an error');
  });
  await test('Settings shows the earlier-attachments switch and saves it', async () => {
    const e = await zipEnv(); e.$('gear').click(); await until(() => e.$('s_priorAtt'));
    assert.equal(e.$('s_priorAtt').checked, true);
    e.$('s_priorAtt').checked = false; e.$('s_priorAtt').dispatchEvent(new e.w.Event('change'));
    await until(() => e.st.settings.priorAttachments === false, 'saved');
  });

  // ----------------------------------------------------------- documents folder
  const removed = { attId: 9, filename: 'Heavy Debris in Thermostat.png', dataUrl: 'https://attachments.test/?readKey=old' };
  const hook = calls => (u, _o, { json, binary }) => {
    const m = u.match(/\/topics\/101\/([1-4])\?/); if (m) { calls.push(+m[1]); return json({ version: +m[1], attachments: +m[1] <= 3 ? [removed] : [], references: [], history: { children: [] } }); }
    if (u.includes('readKey=old')) return json({ url: 'https://files.test/old' });
    if (u === 'https://files.test/old') return binary('debris photo');
  };
  async function update(c, e, id = 'doc_update') {
    e.messages.length = 0; c.$(id).click();
    await until(() => e.messages.some(m => m.action === 'end'), 'folder update'); await until(() => !c.$('doc_update').disabled, 'idle');
  }
  await test('library sync saves attachments removed before the current version and records the check', async () => {
    const e = await D.connected(), calls = [], c = await D.content(e, hook(calls));
    try {
      await update(c, e);
      assert.equal(await e.d.read(`${D.TOPIC}/Attachments and Links/Heavy Debris in Thermostat.png`), 'debris photo');
      assert.deepEqual(calls, [1, 2, 3, 4]);
      assert.equal((await e.db.get('documentsConnection')).progress[D.LI].priorAttachmentsThrough, 4);
      calls.length = 0; c.requests.length = 0; await update(c, e); assert.deepEqual(c.requests, [], 'nothing left to do');
    } finally { c.close(); }
  });
  await test('a new version only reads the versions not yet checked', async () => {
    const e = await D.connected(), calls = [], c = await D.content(e, hook(calls));
    try {
      await update(c, e); calls.length = 0;
      c.active.version = 6; e.state.index[0].version = 6; c.close();
      const c2 = await D.content(e, hook(calls)); c2.active.version = 6;
      try { await update(c2, e); assert.deepEqual(calls.filter(v => v >= 1), [], 'v1–v4 were already read'); } finally { c2.close(); }
      // v5 is the only unchecked earlier version (the hook leaves v5 to the default current metadata).
      assert(c2.requests.some(u => /\/topics\/101\/5\?/.test(u)));
      assert.equal((await e.db.get('documentsConnection')).progress[D.LI].priorAttachmentsThrough, 5);
    } finally { c.close(); }
  });
  await test('catch-up button reads earlier versions for complete archives without requesting PDFs', async () => {
    const e = await D.connected(); await e.d.put(`${D.TOPIC}/${D.LI}_v5.pdf`, D.pdf(5));
    const calls = [], c = await D.content(e, hook(calls));
    try {
      await update(c, e); assert.deepEqual(c.requests, [], 'a routine sync of a complete archive stays free');
      assert(!c.$('doc_prior').disabled);
      await update(c, e, 'doc_prior');
      assert(!c.requests.some(u => u.includes('/file/topics/')), 'no PDFs');
      assert(!c.requests.some(u => u === 'https://files.test/photo'), 'current attachments are not re-downloaded');
      assert.deepEqual(calls, [1, 2, 3, 4]);
      assert.equal(await e.d.read(`${D.TOPIC}/Attachments and Links/Heavy Debris in Thermostat.png`), 'debris photo');
      const p = (await e.db.get('documentsConnection')).progress[D.LI];
      assert.equal(p.priorAttachmentsThrough, 4); assert.equal(p.policy, undefined, 'catch-up does not claim a current-version check');
      assert.match(c.$('doc_status').textContent, /1 of the attachments came from earlier versions/);
      c.requests.length = 0; await update(c, e, 'doc_prior'); assert.deepEqual(c.requests, [], 'checked documents are skipped');
      c.requests.length = 0; await update(c, e); assert.deepEqual(c.requests, [], 'and the routine sync is still free');
    } finally { c.close(); }
  });
  await test('an already-saved identical copy under a (vN) name is not duplicated', async () => {
    const e = await D.connected(); await e.d.put(`${D.TOPIC}/${D.LI}_v5.pdf`, D.pdf(5));
    await e.d.put(`${D.TOPIC}/Attachments and Links/Heavy Debris in Thermostat (v3).png`, 'debris photo');
    const c = await D.content(e, hook([]));
    try {
      await update(c, e, 'doc_prior');
      const dir = await (await (await e.d.getDirectoryHandle('Batch 001')).getDirectoryHandle(`${D.LI} - Old title (Requested)`)).getDirectoryHandle('Attachments and Links');
      const names = []; for await (const f of dir.values()) names.push(f.name);
      assert.deepEqual(names.sort(), ['Heavy Debris in Thermostat (v3).png', 'photo.jpg']);
    } finally { c.close(); }
  });
  await test('a failed earlier-version read is retried next time instead of being marked checked', async () => {
    const e = await D.connected(); await e.d.put(`${D.TOPIC}/${D.LI}_v5.pdf`, D.pdf(5));
    let broken = true; const calls = [], base = hook(calls);
    const c = await D.content(e, (u, o, h) => broken && /\/topics\/101\/2\?/.test(u) ? { ok: false, status: 400 } : base(u, o, h));
    try {
      await update(c, e, 'doc_prior');
      assert.equal((await e.db.get('documentsConnection')).progress[D.LI].priorAttachmentsThrough, undefined);
      broken = false; calls.length = 0; await update(c, e, 'doc_prior');
      assert.deepEqual(calls, [1, 2, 3, 4]); assert.equal((await e.db.get('documentsConnection')).progress[D.LI].priorAttachmentsThrough, 4);
    } finally { c.close(); }
  });
  await test('attachment names Chrome refuses (~, zero-width, soft hyphen, leading dot) are saved under a portable name', async () => {
    const e = await D.connected(); await e.d.put(`${D.TOPIC}/${D.LI}_v5.pdf`, D.pdf(5));
    // An older ZIP-extracted copy with '~' already exists; identical bytes must not be saved again.
    await e.d.put(`${D.TOPIC}/Attachments and Links/Old~copy.png`, 'same bytes');
    e.d.state.strictNames = true;
    const odd = [
      { attId: 21, filename: 'Debris~1.png', key: 't', bytes: 'tilde' },
      { attId: 22, filename: '​Heavy­ Debris.png', key: 'z', bytes: 'zero width' },
      { attId: 23, filename: '.hidden photo.jpg', key: 'h', bytes: 'leading dot' },
      { attId: 24, filename: 'Old~copy.png', key: 's', bytes: 'same bytes' },
      { attId: 25, filename: 'link.url', key: 'u', bytes: 'shell' }];
    const c = await D.content(e, (u, _o, { json, binary }) => {
      if (/\/topics\/101\/[1-4]\?/.test(u)) return json({ version: 1, attachments: odd.map(a => ({ attId: a.attId, filename: a.filename, dataUrl: 'https://attachments.test/?readKey=' + a.key })), references: [], history: { children: [] } });
      const m = u.match(/readKey=(\w)$/); if (m && odd.some(a => a.key === m[1])) return json({ url: 'https://files.test/' + m[1] });
      const f = odd.find(a => u === 'https://files.test/' + a.key); if (f) return binary(f.bytes);
    });
    try {
      await update(c, e, 'doc_prior');
      assert.doesNotMatch(c.$('doc_status').textContent, /not allowed|issue/i);
      const A = `${D.TOPIC}/Attachments and Links/`;
      assert.equal(await e.d.read(A + 'Debris_1.png'), 'tilde');
      assert.equal(await e.d.read(A + 'Heavy Debris.png'), 'zero width');
      assert.equal(await e.d.read(A + 'hidden photo.jpg'), 'leading dot');
      assert.equal(await e.d.read(A + 'link_url'), 'shell');
      const dir = await (await (await e.d.getDirectoryHandle('Batch 001')).getDirectoryHandle(`${D.LI} - Old title (Requested)`)).getDirectoryHandle('Attachments and Links');
      const names = []; for await (const f of dir.values()) names.push(f.name);
      assert(!names.includes('Old_copy.png'), 'the existing ~ copy with identical bytes is reused');
      assert.equal((await e.db.get('documentsConnection')).progress[D.LI].priorAttachmentsThrough, 4);
    } finally { c.close(); }
  });
  await test('portableName matches Chrome folder-API rules', async () => {
    for (const [i, o] of [['Debris~1.png', 'Debris_1.png'], ['​A.png', 'A.png'], ['a­b.jpg', 'ab.jpg'], ['.x.pdf', 'x.pdf'], ['r. ', 'r'], ['s.lnk', 's_lnk'], ['con.txt', '_con.txt'], ['Thumbs.db', '_Thumbs.db'], ['ok name (v2).PNG', 'ok name (v2).PNG']])
      assert.equal(Client.portableName(i), o, i);
  });
  await test('the earlier-version check survives losing the folder progress (reinstall or folder chosen again)', async () => {
    const e = await D.connected(); await e.d.put(`${D.TOPIC}/${D.LI}_v5.pdf`, D.pdf(5));
    const calls = [], c = await D.content(e, hook(calls));
    try {
      await update(c, e, 'doc_prior'); assert.deepEqual(calls, [1, 2, 3, 4]);
      assert.equal(e.state.index[0].priorAttachmentsChecked, 4, 'recorded in the portable index');
      const r = await e.db.get('documentsConnection'); r.progress = {}; await e.db.put('documentsConnection', r);   // what a new install / reconnect leaves
      calls.length = 0; c.requests.length = 0; await update(c, e, 'doc_prior');
      assert.deepEqual(c.requests, [], 'nothing re-read'); assert.match(c.$('doc_status').textContent, /already checked/);
    } finally { c.close(); }
  });
  await test('prior_attachments_checked round-trips through the progress CSV and stays optional', async () => {
    const CSV = require('../index-csv');
    const rows = [{ tips: 'LI1', tipsId: 1, version: 5, title: 'a', mdate: '', priorAttachmentsChecked: 4 }, { tips: 'LI2', tipsId: 2, version: 1, title: 'b', mdate: '' }];
    const text = CSV.stringify(rows); assert.match(text.split('\r\n')[0], /prior_attachments_checked$/);
    assert.deepEqual(CSV.parse(text).index, rows);
    assert.doesNotMatch(CSV.stringify([rows[1]]), /prior_attachments_checked/);
    const applied = CSV.applyPriorChecks(rows, [{ tips: 'li1', tipsId: 1, through: 3 }, { tips: 'LI2', tipsId: 2, through: 0 }]);
    assert.equal(applied.changed, false, 'never moves backwards');
    assert.throws(() => CSV.parse(text.replace('"4"', '"-1"')), /prior_attachments_checked/);
  });
  await test('needsPriorAttachments selects only documents with unchecked earlier versions', async () => {
    const t = last => ({ tips: 'X', versions: [], missingAttachments: [], last });
    assert.equal(Client.needsPriorAttachments(t(null), { version: 1 }), false);
    assert.equal(Client.needsPriorAttachments(t(null), { version: 2 }), true);
    assert.equal(Client.needsPriorAttachments(t({ priorAttachmentsThrough: 4 }), { version: 5 }), false);
    assert.equal(Client.needsPriorAttachments(t({ priorAttachmentsThrough: 4 }), { version: 7 }), true);
  });
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('ERROR ' + e.stack); process.exit(1); });
