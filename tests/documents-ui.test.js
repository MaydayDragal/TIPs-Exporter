const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ROOT = path.join(__dirname, '..');
if (['documents-background.js', 'documents-client.js', 'documents-settings.js'].some(f => !fs.existsSync(path.join(ROOT, f)))) {
  console.log('FAIL document folder Settings, worker, and content integration are not implemented'); process.exit(1);
}
const { LI, TOPIC, ITEM, pdf, tick, until, worker, connected, content, directory, JSDOM } = require('./helpers/documents-env');
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
async function update(c, e) { c.$('doc_update').click(); await until(() => e.messages.some(m => m.action === 'end'), 'folder update'); await until(() => !c.$('doc_update').disabled, 'update idle'); }
(async () => {
  await test('the screenshot GI archive scans and updates through the real content-to-worker flow', async () => {
    const e = worker(), d = directory('Sorted - Stripped'), gi = 'GI72.12-P-053999', folder = `${gi} - Repair paint blistering on inside of 2nd left`;
    e.d = d; e.state.index = [{ tips: gi, tipsId: 102, version: 12, title: 'Repair paint', mdate: '2026-10-09' }]; e.state.done = { 102: { b: 1, v: 12 } };
    for (let v = 1; v <= 11; v++) await d.put(`${folder}/${gi}_v${v}.pdf`, pdf(v));
    await d.put(`${folder}/Attachments and Links/photo.jpg`, 'old photo');
    await e.db.put('documents-candidate:gi', { handle: d }); assert((await e.send('connect', { token: 'gi', options: { auto: false } }, 'options')).ok);
    const c = await content(e, async (u, options, h) => {
      if (options?.method === 'POST') return h.json({ hits: [{ ...e.state.index[0], modificationDate: '2026-10-09' }], totalHits: 1 });
      if (u.includes('/file/topics/102/')) return h.binary(pdf(+u.match(/\/102\/(\d+)/)[1]));
      if (u.includes('/topics/102/')) return h.json({ version: 12, attachments: [{ filename: 'photo.jpg', dataUrl: 'https://attachments.test/?readKey=one' }], references: [], history: { children: [] } });
    });
    try {
      c.$('doc_scan').click(); await until(() => !c.$('doc_scan').disabled);
      assert(c.$('doc_report'), c.$('doc_status').textContent); assert.match(c.$('doc_inventory').textContent, /GI72\.12-P-053999.*missing v12/);
      c.$('doc_report').click(); assert.match(await c.downloads[0].text(), /GI72\.12-P-053999/);
      await update(c, e); assert.equal(await d.read(`${folder}/${gi}_v12.pdf`), pdf(12));
      for (let v = 1; v <= 11; v++) assert.equal(await d.read(`${folder}/${gi}_v${v}.pdf`), pdf(v));
      assert.equal(await d.read(`${folder}/Attachments and Links/photo.jpg`), 'old photo'); assert.equal(await d.read(`${folder}/Attachments and Links/photo (v12).jpg`), 'new photo');
      assert.equal(c.requests.filter(u => u.includes('/file/topics/')).length, 1); assert.equal(e.state.done[102].v, 12);
    } finally { c.close(); }
  });
  await test('documents worker authorizes Settings changes and refuses busy tabs and other owners', async () => {
    const e = worker(), d = directory(); await e.db.put('documents-candidate:first', { handle: d });
    assert.equal((await e.send('connect', { token: 'first' })).ok, false);
    assert.equal((await e.send('status', {}, 'hostile')).ok, false);
    e.tabs.set(1, async () => ({ locked: false })); assert.equal((await e.send('connect', { token: 'first' }, 'options')).ok, false);
    e.tabs.clear(); await e.db.put('documents-candidate:two', { handle: d }); assert.equal((await e.send('connect', { token: 'two' }, 'options')).ok, true);
    e.tabs.set(1, async m => m.type === 'documents-folder-active' ? { active: true } : { locked: true });
    assert.equal((await e.send('start', { token: 'run', snapshot: { index: [ITEM], done: {} } })).ok, true);
    assert.equal((await e.send('start', { token: 'other', snapshot: { index: [] } }, 'reader', 2)).ok, false);
    assert.equal((await e.send('end', { token: 'run' }, 'reader', 2)).ok, false);
    assert.equal((await e.send('end', { token: 'run' })).ok, true);
  });
  await test('abandoned folder runs can be recovered but a live owner cannot be displaced', async () => {
    const e = await connected(); assert.equal((await e.send('start', { token: 'old', snapshot: { index: [ITEM] } })).ok, true);
    assert.equal((await e.send('start', { token: 'new', snapshot: { index: [ITEM] } }, 'reader', 2)).ok, true);
    assert.equal((await e.send('end', { token: 'old' })).ok, false);
    assert.equal((await e.send('end', { token: 'new' }, 'reader', 2)).ok, true);
  });
  await test('Settings persists a picked documents directory, editable attachment subfolder, auto setting and renewed access', async () => {
    const e = worker(), d = directory(), dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'folder-settings.html'), 'utf8'), { runScripts: 'outside-only', url: 'https://extension.test/' });
    const w = dom.window, $ = id => w.document.getElementById(id); let picks = 0;
    w.TIPSFolderDB = e.db; w.showDirectoryPicker = async o => { assert.equal(o.mode, 'readwrite'); picks++; return d; };
    w.chrome = { ...e.chrome, runtime: { ...e.chrome.runtime, sendMessage: m => e.send(m.action, m, 'options') } };
    w.eval(fs.readFileSync(path.join(ROOT, 'documents-settings.js'), 'utf8'));
    await until(() => !$('choose-documents').disabled); $('choose-documents').click(); await until(() => !$('use-documents').disabled);
    $('documents-attachments').value = 'Photos and files'; $('documents-auto').checked = false; $('use-documents').click();
    await until(() => e.state.documentsFolder?.configured); await until(() => !$('allow-documents').disabled);
    assert.equal(picks, 1); assert.equal((await e.db.get('documentsConnection')).handle, d); assert.equal(e.state.documentsFolder.attachmentFolder, 'Photos and files'); assert.equal(e.state.documentsFolder.auto, false);
    d.state.permission = 'prompt'; $('allow-documents').click(); await until(() => d.state.permission === 'granted');
    await until(() => !$('save-documents').disabled); $('documents-auto').checked = true; $('save-documents').click(); await until(() => e.state.documentsFolder.auto);
    dom.window.close();
  });
  await test('scan compares disk to exported and pending index rows, downloads a CSV and never changes progress', async () => {
    const e = await connected(); e.state.index[0].title = '=1+1'; e.state.index.push({ ...ITEM, tips: 'LI20.10-P-075374', tipsId: 102 });
    const before = JSON.stringify(e.state.done), c = await content(e);
    try {
      c.$('doc_scan').click(); await until(() => c.$('doc_report')); assert.match(c.$('doc_inventory').textContent, /1.*pending|pending.*1/i); assert.match(c.$('doc_inventory').textContent, /v5|5/);
      c.$('doc_report').click(); assert.equal(c.downloads.length, 1); const csv = await c.downloads[0].text();
      assert.match(csv, /saved_versions/i); assert.match(csv, /missing_versions/i); assert.match(csv, /LI20.10-P-075374/); assert.match(csv, /pending/); assert.equal(JSON.stringify(e.state.done), before); assert.equal(e.d.state.writes.length, 0);
      assert(csv.includes('"\'=1+1"'), 'inventory titles are safe to open in a spreadsheet');
    } finally { c.close(); }
  });
  await test('manual update adds v5 beside v1-v4 and preserves old photos without marking bulk progress', async () => {
    const e = await connected(), before = JSON.stringify(e.state.done), c = await content(e);
    try {
      await update(c, e); for (let v = 1; v <= 5; v++) assert.equal(await e.d.read(`${TOPIC}/${LI}_v${v}.pdf`), pdf(v));
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo.jpg`), 'old photo'); assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5).jpg`), 'new photo');
      assert.equal(c.requests.filter(u => u.includes('/file/topics/')).length, 1); assert.equal(JSON.stringify(e.state.done), before);
      assert.equal((await e.db.get('documentsConnection')).progress[LI].ok, true); assert.match(c.$('doc_inventory').textContent, /1.*complete|complete.*1/i);
      e.messages.length = 0; await update(c, e); assert.equal(e.d.state.writes.length, 2, 'unchanged files are not duplicated');
    } finally { c.close(); }
  });
  await test('Check new automatically updates saved LIs while same-version attachment changes remain detectable', async () => {
    const e = await connected({ auto: true }), c = await content(e);
    try {
      await update(c, e); e.messages.length = 0; c.active.attachment = 'revised photo'; c.active.mdate = '2026-10-09';
      c.$('refresh').click(); await until(() => e.messages.some(m => m.action === 'end'), 'automatic update'); await until(() => !c.$('doc_update').disabled);
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5-2).jpg`), 'revised photo'); assert.equal(e.state.index[0].mdate, '2026-10-09'); assert.equal(e.state.done[101].v, 5);
    } finally { c.close(); }
  });
  await test('Stop keeps completed files and blocks Settings changes while an update is active', async () => {
    const e = await connected(); let release;
    const c = await content(e, async (u, _o, h) => u === 'https://files.test/photo' ? new Promise(resolve => { release = () => resolve(h.binary('new photo')); }) : null);
    try {
      c.$('doc_update').click(); await until(() => release); assert.equal((await e.send('configure', { options: { auto: false } }, 'options')).ok, false);
      c.$('doc_stop').click(); release(); await until(() => !c.$('doc_update').disabled);
      assert.equal(e.data.has('documentsRun'), false); assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo.jpg`), 'old photo');
      assert.match(c.$('doc_status').textContent, /stop|cancel/i);
    } finally { c.close(); }
  });
  await test('binary transfer survives the Chrome JSON boundary and rejects a cancelled write', async () => {
    const e = await connected(), Client = require('../documents-client');
    const r = await e.send('start', { token: 'transfer', snapshot: { index: [ITEM] } }); assert.equal(r.ok, true);
    const data = new Uint8Array(600001); for (let i = 0; i < data.length; i++) data[i] = i % 256;
    const send = async (a,p) => { const r = await e.send(a,p); if (!r.ok) throw Error(r.error); return r; };
    await Client.write(send, 'transfer', LI, 5, { path: 'Attachments and Links/large.bin', data }, () => false);
    const dir = await (await (await e.d.getDirectoryHandle('Batch 001')).getDirectoryHandle(`${LI} - Old title (Requested)`)).getDirectoryHandle('Attachments and Links');
    assert.deepEqual((await dir.getFileHandle('large.bin')).bytes, data); assert.equal(e.messages.filter(m => m.action === 'chunk').length, 3);
    await assert.rejects(Client.write(send, 'transfer', LI, 5, { path: 'Attachments and Links/cancel.bin', data }, () => true), /cancel|stop/i);
    await e.send('end', { token: 'transfer' });
  });
  await test('a manual update creates a missing LI only with Include missing selected', async () => {
    const e = worker(), d = directory(); e.d = d; await e.db.put('documents-candidate:empty', { handle: d });
    assert((await e.send('connect', { token: 'empty', options: { auto: false } }, 'options')).ok);
    const c = await content(e);
    try {
      await update(c, e); assert.equal(d.children.size, 0); e.messages.length = 0;
      c.$('doc_missing').checked = true; c.$('doc_missing').dispatchEvent(new c.w.Event('change')); await update(c, e);
      const base = `${LI} - New title (Requested)`;
      for (let v = 1; v <= 5; v++) assert.equal(await d.read(`${base}/${LI}_v${v}.pdf`), pdf(v));
      assert.equal(await d.read(`${base}/Attachments and Links/photo.jpg`), 'new photo'); assert.equal(e.state.done[101].v, 5);
    } finally { c.close(); }
  });
  await test('native folder updates use the real scrubber for new PDFs and PDF attachments', async () => {
    const L = require('../vendor/pdf-lib.min.js'), doc = await L.PDFDocument.create();
    doc.setAuthor('Private author'); doc.setTitle('Private title'); doc.addPage().drawText('Workshop instructions');
    const original = await doc.save(), e = await connected(); e.state.settings.pdfScrub = { enabled: true, user: false, timestamp: false, strings: '' };
    const c = await content(e, async (u, _o, h) => u.includes('/file/topics/') || u === 'https://files.test/photo' ? h.binary(original) : null);
    try {
      await update(c, e);
      for (const name of [`${LI}_v5.pdf`, 'Attachments and Links/photo (v5).jpg']) {
        const parts = `${TOPIC}/${name}`.split('/'), n = parts.pop(); let d = e.d;
        for (const p of parts) d = await d.getDirectoryHandle(p);
        const parsed = await L.PDFDocument.load((await d.getFileHandle(n)).bytes, { updateMetadata: false });
        assert.equal(parsed.getPageCount(), 1); assert.equal(parsed.context.trailerInfo.Info, undefined);
      }
      assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`), pdf(4));
    } finally { c.close(); }
  });
  await test('failed PDF scrubbing leaves existing files intact and reports missing latest coverage', async () => {
    const e = await connected(); e.state.settings.pdfScrub = { enabled: true }; const c = await content(e);
    try {
      await update(c, e); await assert.rejects(e.d.read(`${TOPIC}/${LI}_v5.pdf`), /NotFound/);
      assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`), pdf(4)); assert.match(c.$('doc_status').textContent, /scrub failed/);
      assert.equal((await e.db.get('documentsConnection')).progress[LI].ok, false); assert.match(c.$('doc_inventory').textContent, /missing v5/);
    } finally { c.close(); }
  });
  await test('failed attachment close after an earlier success is retried automatically with the same version and date', async () => {
    const e = await connected({ auto: true }), c = await content(e);
    try {
      await update(c, e); c.active.attachment = 'revision after success'; e.d.state.failClose = true; e.messages.length = 0;
      await update(c, e); assert.equal((await e.db.get('documentsConnection')).progress[LI].ok, false);
      e.d.state.failClose = false; e.messages.length = 0; c.$('refresh').click(); await until(() => e.messages.some(m => m.action === 'end')); await until(() => !c.$('doc_update').disabled);
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5-2).jpg`), 'revision after success');
      assert.equal((await e.db.get('documentsConnection')).progress[LI].ok, true);
    } finally { c.close(); }
  });
  await test('Stop after an earlier success persists a retry marker before network work finishes', async () => {
    const e = await connected({ auto: true }); let block = false, release;
    const c = await content(e, async (u, _o, h) => block && u === 'https://files.test/photo' ? new Promise(resolve => { release = () => resolve(h.binary('next revision')); }) : null);
    try {
      await update(c, e); block = true; e.messages.length = 0; c.$('doc_update').click(); await until(() => release);
      assert.equal((await e.db.get('documentsConnection')).progress[LI].ok, false);
      c.$('doc_stop').click(); release(); await until(() => !c.$('doc_update').disabled);
      assert.equal((await e.db.get('documentsConnection')).progress[LI].ok, false); assert.equal(e.data.has('documentsRun'), false);
    } finally { c.$('doc_stop')?.click(); release?.(); await until(() => !c.$('doc_update').disabled); c.close(); }
  });
  await test('the report names a corrupt newer PDF even when the loaded index is older', async () => {
    const e = await connected(); await e.d.put(`${TOPIC}/${LI}_v6.pdf`, 'corrupt'); e.state.index[0].version = 4;
    const c = await content(e);
    try {
      c.$('doc_scan').click(); await until(() => c.$('doc_report'));
      assert.match(c.$('doc_inventory').textContent, /invalid v6/); assert(!c.$('doc_inventory').textContent.includes('All indexed PDF versions found'));
    } finally { c.close(); }
  });
  process.exit(process.exitCode || 0);
})();
