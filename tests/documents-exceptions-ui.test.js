const assert = require('node:assert/strict');
const { LI, TOPIC, ITEM, makePdf, assertSavedPdf, pdf, until, connected, content } = require('./helpers/documents-env');
const CSV = require('../index-csv');
const AT = '2026-10-09T12:00:00.000Z';
const exception = (version, kind = 'unavailable', reason = 'Version not available in TIPS') => ({ version, kind, reason, at: AT });
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
async function scan(c) { c.$('doc_scan').click(); await until(() => !c.$('doc_scan').disabled, 'scan idle'); }
async function update(c, e, retry = false) {
  e.messages.length = 0; assert(c.$(retry ? 'doc_retry' : 'doc_update'), 'update control exists'); c.$(retry ? 'doc_retry' : 'doc_update').click();
  await until(() => e.messages.some(m => m.action === 'end'), 'folder update'); await until(() => !c.$('doc_update').disabled, 'update idle');
}
async function topicFolder(e) { return (await e.d.getDirectoryHandle('Batch 001')).getDirectoryHandle(`${LI} - Old title (Requested)`); }
async function indexFolder(e) {
  const d = { name: 'Index', text: CSV.stringify(e.state.index, e.state.done), fail: false,
    queryPermission: async () => 'granted',
    getFileHandle: async () => ({ getFile: async () => ({ size: d.text.length, text: async () => d.text }), createWritable: async () => {
      let next; return { write: async value => { if (d.fail) throw Error('Index disk unavailable'); next = value; }, close: async () => { d.text = next; }, abort: async () => {} };
    } }) };
  await e.db.put('candidate:index', { handle: d, filename: 'index.csv' });
  const r = await e.send('connect', { type: 'index-folder', token: 'index' }, 'options'); assert(r.ok, r.error); return d;
}
(async () => {
  await test('the seven reported legacy failures migrate to the shared index with no TIPS requests', async () => {
    const e = await connected(), r = await e.db.get('documentsConnection');
    const examples = [['LI08.30-P-057146',3],['LI47.30-P-056273',1],['LI54.10-P-079534',2,'scrub_failed'],['LI72.12-P-044297',1],['LI82.70-P-071024',8,'scrub_failed'],['LI88.60-P-072093',1],['LI88.70-P-044574',1]];
    e.state.index = examples.map(([tips,version],i) => ({ tips, version, tipsId: 201+i, title: 'Test', mdate: ITEM.mdate })); e.state.done = {};
    const errors = [];
    for (const [tips,v,kind] of examples) {
      for (let n = 1; n < v; n++) await e.d.put(`${tips}/${tips}_v${n}.pdf`, pdf(n));
      if (kind) await e.d.put(`${tips}/${tips}_v${v}.pdf`, 'invalid original');
      r.progress[tips] = { version: v, mdate: ITEM.mdate, ok: !kind, unavailable: kind ? [] : [v], at: AT, files: [] };
      errors.push(kind ? `${tips} - Test (Requested)/${tips}_v${v}.pdf: PDF scrub failed (unsupported, damaged, or unreadable PDF); PDF omitted.` : `${tips}: v${v} not available in TIPS`);
    }
    await e.db.put('documentsStatus', { epoch: r.epoch, summary: { errors } }); const disk = await indexFolder(e), c = await content(e);
    try {
      await scan(c); assert.deepEqual(c.requests, []); assert.equal(CSV.parse(disk.text).index.flatMap(x => x.exceptions || []).length, 7);
      assert.equal((await e.db.get('documentsConnection')).pendingExceptions.length, 0);
      assert.match(c.$('doc_exceptions').textContent, /7 excluded PDF versions/); assert.match(c.$('doc_inventory').textContent, /3 of 3 required documents complete/);
      await update(c, e); assert.deepEqual(c.requests, []); assert.deepEqual(e.state.done, {});
    } finally { c.close(); }
  });
  await test('Scan & verify saves nested attachment inventory in the main CSV and retains missing expectations', async () => {
    const e = await connected(); await e.d.put(`${TOPIC}/Attachments and Links/nested/manual.txt`, 'manual');
    const disk = await indexFolder(e), before = JSON.stringify(e.state.done), c = await content(e);
    try {
      await scan(c); const first = CSV.parse(disk.text).index[0].attachmentInventory;
      assert.equal(first.files.length, 2); assert(first.files.some(f => f.path === 'Attachments and Links/nested/manual.txt' && f.size === 6));
      await (await (await topicFolder(e)).getDirectoryHandle('Attachments and Links')).removeEntry('photo.jpg');
      await scan(c); assert.equal(CSV.parse(disk.text).index[0].attachmentInventory.files.length, 2);
      assert.match(c.$('doc_inventory').textContent, /Missing tracked attachments: 1/);
      assert.deepEqual(c.requests, []); assert.equal(e.d.state.writes.length, 0); assert.equal(JSON.stringify(e.state.done), before);
    } finally { c.close(); }
  });
  await test('future scrub failures are recorded automatically and skipped on the next routine update', async () => {
    const e = await connected(); e.state.settings.pdfScrub = { enabled: true }; const c = await content(e, async (u, _o, h) => u.includes('/file/topics/') ? h.binary('%PDF-invalid') : null);
    try {
      await update(c, e); assert.equal(e.state.index[0].exceptions[0].kind, 'scrub_failed'); assert.equal(e.state.index[0].exceptions[0].version, 5);
      assert.match(c.$('doc_exceptions').textContent, /scrub_failed/); assert(!c.$('doc_inventory').textContent.includes('missing v5'));
      c.requests.length = 0; await update(c, e); assert.deepEqual(c.requests, []); assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`), pdf(4));
    } finally { c.close(); }
  });
  await test('future attachment failures remain retryable and clear independently of older exclusions', async () => {
    const e = await connected(); await (await topicFolder(e)).removeEntry(`${LI}_v2.pdf`); e.state.index[0].exceptions = [exception(2)];
    let fail = true; const c = await content(e, async u => fail && u === 'https://files.test/photo' ? { ok: false, status: 404 } : null);
    try {
      await update(c, e); assert(e.state.index[0].exceptions.some(x => x.kind === 'retryable' && /attachment.*404/.test(x.reason)));
      fail = false; c.requests.length = 0; await update(c, e);
      assert.deepEqual(e.state.index[0].exceptions, [exception(2)]); assert(!c.requests.some(u => /\/file\/topics\//.test(u)));
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5).jpg`), 'new photo');
    } finally { c.close(); }
  });
  await test('new versions download while earlier excluded PDFs stay skipped', async () => {
    const e = await connected(); e.state.index[0].version = 6; e.state.index[0].exceptions = [exception(5)]; const c = await content(e); c.active.version = 6;
    try {
      await update(c, e); await assertSavedPdf(e.d, `${TOPIC}/${LI}_v6.pdf`, 6); assert(!c.requests.some(u => /\/file\/topics\/101\/5\?/.test(u)));
      assert.deepEqual(e.state.index[0].exceptions, [exception(5)]); c.requests.length = 0; await update(c,e); assert.deepEqual(c.requests, []);
    } finally { c.close(); }
  });
  await test('explicit retries fetch only excluded versions and remove records only after successful saves', async () => {
    const e = await connected(); e.state.index[0].version = 6; e.state.index[0].exceptions = [exception(5)];
    e.state.index.push({ ...ITEM, tips: 'LI20.10-P-075374', tipsId: 102 }); const c = await content(e); c.active.version = 6;
    try {
      await scan(c); await update(c, e, true); await assertSavedPdf(e.d, `${TOPIC}/${LI}_v5.pdf`, 5);
      assert.equal(e.state.index[0].exceptions, undefined); assert.equal(c.requests.length, 2, 'only metadata and excluded PDF');
      assert(!c.requests.some(u => /\/102\/|\/search|\/file\/topics\/101\/6\?/.test(u)));
      c.requests.length = 0; await update(c, e); await assertSavedPdf(e.d, `${TOPIC}/${LI}_v6.pdf`, 6);
    } finally { c.close(); }
  });
  await test('retrying a still unavailable version refreshes its date without polling attachments', async () => {
    const e = await connected(); e.state.index[0].exceptions = [exception(5)]; const c = await content(e, async u => u.includes('/file/topics/') ? { ok: false, status: 404 } : null);
    try {
      await scan(c); await update(c, e, true); const x = e.state.index[0].exceptions[0]; assert.equal(x.kind, 'unavailable'); assert.notEqual(x.at, AT);
      assert.equal(c.requests.length, 2); c.requests.length = 0; await update(c, e); assert.deepEqual(c.requests, []);
    } finally { c.close(); }
  });
  await test('an unavailable current topic metadata response stays excluded after an explicit retry', async () => {
    const e = await connected(); e.state.index[0].exceptions = [exception(5)];
    const c = await content(e, async u => u.includes('/topics/101/5') && !u.includes('/file/') ? { ok: false, status: 404 } : null);
    try {
      await scan(c); await update(c, e, true);
      assert.equal(e.state.index[0].exceptions.length, 1); assert.equal(e.state.index[0].exceptions[0].kind, 'unavailable'); assert.notEqual(e.state.index[0].exceptions[0].at, AT);
      assert.equal(c.requests.length, 1); c.requests.length = 0; await update(c,e); assert.deepEqual(c.requests, []);
    } finally { c.close(); }
  });
  await test('an invalid existing file is preserved and its excluded version is not falsely resolved', async () => {
    const e = await connected(); e.state.index[0].exceptions = [exception(5, 'scrub_failed', 'PDF unreadable')]; await e.d.put(`${TOPIC}/${LI}_v5.pdf`, 'damaged'); const c = await content(e);
    try {
      await scan(c); await update(c,e,true); assert.equal(await e.d.read(`${TOPIC}/${LI}_v5.pdf`), 'damaged');
      assert(e.state.index[0].exceptions.some(x => x.kind === 'scrub_failed')); assert(e.state.index[0].exceptions.some(x => x.kind === 'retryable' && /preserved/.test(x.reason)));
    } finally { c.close(); }
  });
  await test('failed index disk writes retain metadata in Chrome and synchronize on a later save', async () => {
    const e = await connected(), disk = await indexFolder(e), c = await content(e); disk.fail = true;
    try {
      await scan(c); assert.equal(e.state.index[0].attachmentInventory.files.length, 1); assert.equal(CSV.parse(disk.text).index[0].attachmentInventory, undefined);
      disk.fail = false; await scan(c); assert.equal(CSV.parse(disk.text).index[0].attachmentInventory.files.length, 1); assert.deepEqual(c.requests, []);
    } finally { c.close(); }
  });
  await test('stale index saves leave exception events pending and preserve newer index progress', async () => {
    const e = await connected(), r = await e.db.get('documentsConnection'); r.progress[LI] = { version: 5, mdate: ITEM.mdate, ok: true, unavailable: [5], at: AT, files: [] };
    const c = await content(e), original = c.w.chrome.runtime.sendMessage; let raced = false;
    c.w.chrome.runtime.sendMessage = async m => {
      if (!raced && m.type === 'index-folder' && m.action === 'save') { raced = true; e.state.index[0].title = 'Updated in another tab'; }
      return original(m);
    };
    try {
      await scan(c); assert.match(c.$('doc_status').textContent, /changed|newer|another tab/i); assert.equal(e.state.index[0].title, 'Updated in another tab');
      assert.equal((await e.db.get('documentsConnection')).pendingExceptions.length, 1); assert(!e.messages.some(m => m.action === 'ack-exceptions'));
      await scan(c); assert.equal(e.state.index[0].exceptions[0].version, 5); assert.equal((await e.db.get('documentsConnection')).pendingExceptions.length, 0);
    } finally { c.close(); }
  });
  await test('rejected browser saves cannot acknowledge unsaved exceptions on a later scan', async () => {
    const e = await connected(), r = await e.db.get('documentsConnection'); e.state.index[0].version = 1;
    await (await e.d.getDirectoryHandle('Batch 001')).removeEntry(`${LI} - Old title (Requested)`);
    r.progress[LI] = { version: 1, mdate: ITEM.mdate, ok: true, unavailable: [1], at: AT, files: [] };
    const c = await content(e), original = c.w.chrome.runtime.sendMessage; let fail = true;
    c.w.chrome.runtime.sendMessage = async m => fail && m.type === 'index-folder' && m.action === 'save' ? { ok: false, error: 'Browser storage unavailable' } : original(m);
    try {
      await scan(c); assert.equal(e.state.index[0].exceptions, undefined); assert.equal((await e.db.get('documentsConnection')).pendingExceptions.length, 1);
      await scan(c); assert.equal((await e.db.get('documentsConnection')).pendingExceptions.length, 1, 'a second rejected save cannot discard the journal');
      fail = false; await scan(c); assert.equal(e.state.index[0].exceptions[0].version, 1); assert.equal((await e.db.get('documentsConnection')).pendingExceptions.length, 0);
    } finally { c.close(); }
  });
  process.exit(process.exitCode || 0);
})();
