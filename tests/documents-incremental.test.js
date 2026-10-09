const assert = require('node:assert/strict');
const { LI, TOPIC, ITEM, makePdf, assertSavedPdf, pdf, until, connected, content } = require('./helpers/documents-env');
const Client = require('../documents-client');
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
async function update(c, e) {
  e.messages.length = 0; c.$('doc_update').click();
  await until(() => e.messages.some(m => m.action === 'end'), 'folder update');
  await until(() => !c.$('doc_update').disabled, 'update idle');
}
async function complete(options = {}) { const e = await connected(options); await e.d.put(`${TOPIC}/${LI}_v5.pdf`, pdf(5)); return e; }
const topic = extra => ({ tips: LI, versions: [1,2,3,4,5], missingAttachments: [], last: null, ...extra });
(async () => {
  await test('complete pre-existing archives make zero TIPS requests without any update history', async () => {
    const e = await complete(), c = await content(e);
    try {
      await update(c, e); assert.deepEqual(c.requests, []);
      assert.equal(e.d.state.writes.length, 0); assert.match(c.$('doc_status').textContent, /no document requests/i);
      assert.equal((await e.db.get('documentsConnection')).progress[LI], undefined, 'an index baseline does not claim a live attachment check');
    } finally { c.close(); }
  });
  await test('manual updates fetch only the indexed gap and use its ID without per-document searches', async () => {
    const e = await connected(), other = 'LI20.10-P-075374';
    e.state.index.push({ ...ITEM, tips: other, tipsId: 102 });
    for (let v = 1; v <= 5; v++) await e.d.put(`${other}/${other}_v${v}.pdf`, pdf(v));
    const c = await content(e);
    try {
      await update(c, e);
      assert.equal(c.requests.length, 4, 'one metadata request, one missing PDF, one attachment URL, one attachment download');
      assert(!c.requests.some(u => u.includes('/search') || u.includes('/topics/102/')));
      await assertSavedPdf(e.d, `${TOPIC}/${LI}_v5.pdf`, 5);
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo.jpg`), 'old photo');
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5).jpg`), 'new photo');
      c.requests.length = 0; await update(c, e); assert.deepEqual(c.requests, [], 'a second update does no remote work');
    } finally { c.close(); }
  });
  await test('a historical PDF gap does not redownload unchanged current attachments', async () => {
    const e = await complete();
    const batch = await e.d.getDirectoryHandle('Batch 001'), folder = await batch.getDirectoryHandle(`${LI} - Old title (Requested)`);
    await folder.removeEntry(`${LI}_v2.pdf`);
    const c = await content(e);
    try {
      await update(c, e); await assertSavedPdf(e.d, `${TOPIC}/${LI}_v2.pdf`, 2);
      assert.equal(c.requests.length, 2, 'only indexed metadata and the missing historical PDF');
      assert(!c.requests.some(u => u.includes('/read/download/url') || u.startsWith('https://files.test/')));
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo.jpg`), 'old photo');
    } finally { c.close(); }
  });
  await test('Check new captures attachment-only changes on a complete archive with no prior live check', async () => {
    const e = await complete({ auto: true }), c = await content(e);
    try {
      c.active.mdate = '2026-10-09'; c.active.attachment = 'changed after index'; c.$('refresh').click();
      await until(() => e.messages.some(m => m.action === 'end')); await until(() => !c.$('doc_update').disabled);
      assert.equal(c.requests.filter(u => u.includes('/search')).length, 1, 'only the recent-index search');
      assert.equal(c.requests.filter(u => u.includes('/file/topics/')).length, 0);
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5).jpg`), 'changed after index');
      c.requests.length = 0; e.messages.length = 0; c.$('refresh').click();
      await until(() => e.messages.some(m => m.action === 'end')); await until(() => !c.$('doc_update').disabled);
      assert.equal(c.requests.length, 1, 'unchanged Check new needs only the recent-index search');
    } finally { c.close(); }
  });
  await test('an unchanged first Check new makes only the recent-index request', async () => {
    const e = await complete({ auto: true }), c = await content(e);
    try {
      c.$('refresh').click(); await until(() => e.messages.some(m => m.action === 'end')); await until(() => !c.$('doc_update').disabled);
      assert.equal(c.requests.length, 1); assert(c.requests[0].includes('/search')); assert.equal(e.d.state.writes.length, 0);
    } finally { c.close(); }
  });
  await test('offline scan baseline survives reload and detects a later same-version index edit', async () => {
    const e = await complete(); let c = await content(e);
    try {
      c.$('doc_scan').click(); await until(() => c.$('doc_report')); assert.deepEqual(c.requests, []);
      c.close(); e.state.index[0].mdate = '2026-10-09'; c = await content(e); c.active.mdate = '2026-10-09';
      await update(c, e); assert.equal(c.requests.length, 3); assert(!c.requests.some(u => u.includes('/search')));
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5).jpg`), 'new photo');
    } finally { c.close(); }
  });
  for (const previousRun of [false, true]) await test(`a missing index date learns a baseline without a sweep${previousRun ? ' after an older successful update' : ''}`, async () => {
    const e = await complete({ auto: true }); e.state.index[0].mdate = '';
    if (previousRun) (await e.db.get('documentsConnection')).progress[LI] = { version: 5, mdate: '', ok: true, files: [] };
    const c = await content(e);
    try {
      c.$('refresh').click(); await until(() => e.messages.some(m => m.action === 'end')); await until(() => !c.$('doc_update').disabled);
      assert.equal(c.requests.length, 1, 'learning a previously unknown date needs only the index search');
      e.messages.length = 0; c.requests.length = 0; c.active.mdate = '2026-10-09'; c.active.attachment = 'later attachment edit';
      c.$('refresh').click(); await until(() => e.messages.some(m => m.action === 'end')); await until(() => !c.$('doc_update').disabled);
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5).jpg`), 'later attachment edit');
      assert.equal(c.requests.filter(u => u.includes('/search')).length, 1);
    } finally { c.close(); }
  });
  await test('previously unavailable historical versions are not requested again during another repair', async () => {
    const e = await complete(), r = await e.db.get('documentsConnection');
    const folder = await (await e.d.getDirectoryHandle('Batch 001')).getDirectoryHandle(`${LI} - Old title (Requested)`);
    await folder.removeEntry(`${LI}_v2.pdf`); await folder.removeEntry(`${LI}_v3.pdf`);
    r.progress[LI] = { version: 5, mdate: ITEM.mdate, ok: true, unavailable: [2], files: [] };
    const c = await content(e);
    try {
      await update(c, e); await assertSavedPdf(e.d, `${TOPIC}/${LI}_v3.pdf`, 3);
      assert(!c.requests.some(u => /\/file\/topics\/101\/2\?/.test(u)));
      assert.deepEqual((await e.db.get('documentsConnection')).progress[LI].unavailable, [2]);
      c.requests.length = 0; await update(c, e); assert.deepEqual(c.requests, []);
    } finally { c.close(); }
  });
  await test('missing tracked attachments are repaired without requesting existing PDFs', async () => {
    const e = await connected(), c = await content(e);
    try {
      await update(c, e);
      const folder = await (await e.d.getDirectoryHandle('Batch 001')).getDirectoryHandle(`${LI} - Old title (Requested)`);
      await (await folder.getDirectoryHandle('Attachments and Links')).removeEntry('photo (v5).jpg');
      c.requests.length = 0; await update(c, e);
      assert.equal(c.requests.length, 3); assert(!c.requests.some(u => u.includes('/search') || u.includes('/file/topics/')));
      assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5).jpg`), 'new photo');
    } finally { c.close(); }
  });
  await test('a failed metadata request retains unavailable-version history for the next retry', async () => {
    const e = await complete(), r = await e.db.get('documentsConnection');
    const folder = await (await e.d.getDirectoryHandle('Batch 001')).getDirectoryHandle(`${LI} - Old title (Requested)`);
    await folder.removeEntry(`${LI}_v2.pdf`); await folder.removeEntry(`${LI}_v3.pdf`);
    r.progress[LI] = { version: 5, mdate: ITEM.mdate, ok: true, unavailable: [2], files: [] };
    let fail = true;
    const c = await content(e, async u => fail && u.includes('/topics/101/') && !u.includes('/file/') ? { ok: false, status: 404 } : null);
    try {
      await update(c, e);
      assert.equal((await e.db.get('documentsConnection')).progress[LI].ok, false);
      assert.deepEqual((await e.db.get('documentsConnection')).progress[LI].unavailable, [2]);
      fail = false; c.requests.length = 0; await update(c, e);
      assert(!c.requests.some(u => /\/file\/topics\/101\/2\?/.test(u)));
      await assertSavedPdf(e.d, `${TOPIC}/${LI}_v3.pdf`, 3);
    } finally { c.close(); }
  });
  await test('missing history and scrub-rule changes alone do not select complete documents', async () => {
    assert.equal(Client.needsUpdate(topic(), ITEM, 'new scrub rules'), false);
    assert.equal(Client.needsUpdate(topic({ last: { ok: true, version: 5, mdate: ITEM.mdate, policy: 'old scrub rules' } }), ITEM, 'new scrub rules'), false);
    assert.equal(Client.needsUpdate(topic({ last: { ok: false, version: 5, mdate: ITEM.mdate } }), ITEM), true, 'an interrupted update remains retryable');
  });
  await test('older indexes and equivalent date formats do not select completed documents', async () => {
    const last = { ok: true, version: 5, mdate: '2026-10-08T00:00:00Z' };
    assert.equal(Client.needsUpdate(topic({ last }), ITEM), false);
    assert.equal(Client.needsUpdate(topic({ last }), { ...ITEM, mdate: '2026-10-07' }), false);
    assert.equal(Client.needsUpdate(topic({ last }), { ...ITEM, version: 4, mdate: '2026-10-09' }), false);
    assert.equal(Client.needsUpdate(topic({ last }), { ...ITEM, mdate: '2026-10-09' }), true);
  });
  process.exit(process.exitCode || 0);
})();
