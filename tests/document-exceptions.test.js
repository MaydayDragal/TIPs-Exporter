const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { directory } = require('./helpers/memory-fs');
const CSV = require('../index-csv'), Client = require('../documents-client'), Docs = require('../documents-folder');
globalThis.crypto ||= webcrypto;
const AT = '2026-10-09T12:00:00.000Z', LI = 'LI08.30-P-057146';
const item = { tips: LI, tipsId: 101, version: 4, title: 'Test document', mdate: '2026-10-08' };
const exception = (version, kind = 'unavailable') => ({ version, kind, reason: kind === 'unavailable' ? 'Version not available in TIPS' : 'PDF could not be scrubbed: unsupported, damaged, or unreadable PDF', at: AT });
const event = (id, action, version = 3) => ({ id, tips: LI, tipsId: 101, action, version, ...(action === 'exclude' ? { exception: exception(version) } : {}) });
const pdf = v => `%PDF-1.7\nVersion ${v}\n%%EOF`;
function env() { const data = new Map(), db = { get: async k => data.get(k), put: async (k,v) => data.set(k,v), del: async k => data.delete(k) }; return { data, db, repo: Docs.create({ db, now: () => AT }) }; }
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
(async () => {
  await test('portable index exceptions round-trip without changing legacy logs or exported progress', () => {
    const done = { 101: { b: 2, d: AT, v: 4 } }, legacy = CSV.stringify([item], done);
    assert.equal(legacy.split('\r\n')[0].split(',').length, 9);
    assert.deepEqual(CSV.parse(legacy), { index: [item], done });
    const extended = [{ ...item, exceptions: [exception(2, 'scrub_failed'), exception(3)] }], text = CSV.stringify(extended, done);
    assert(text.split('\r\n')[0].endsWith(',document_exceptions'));
    assert.deepEqual(CSV.parse(text), { index: extended, done });
    assert.deepEqual(CSV.parse(CSV.stringify([], {})), { index: [], done: {} });
  });
  await test('invalid exception columns are rejected before they can suppress required versions', () => {
    for (const value of [[exception(0)], [exception(10001)], [exception(2), exception(2)], [{ ...exception(2), kind: 'network' }], [{ ...exception(2), at: 'bad-date' }], 'not-an-array']) {
      assert.throws(() => CSV.normalizeExceptions(value), /exception/i);
    }
    const valid = CSV.stringify([{ ...item, exceptions: [exception(3)] }]);
    assert.throws(() => CSV.parse(valid.replace('unavailable', 'network')), /exception/i);
    assert.throws(() => CSV.parse(valid.split('\r\n')[0] + ', document_exceptions'), /index|progress|CSV/i);
  });
  await test('journal application binds topic IDs and resolves only the named version', () => {
    const rows = [item], events = [event('one', 'exclude'), { ...event('wrong-id', 'exclude', 2), tipsId: 999 }];
    const added = CSV.applyExceptionEvents(rows, events);
    assert.deepEqual(added.ids, ['one']); assert.equal(added.changed, true); assert.equal(rows[0].exceptions, undefined);
    assert.deepEqual(added.index[0].exceptions, [exception(3)]);
    const repeated = CSV.applyExceptionEvents(added.index, [events[0]]); assert.equal(repeated.changed, false);
    const resolved = CSV.applyExceptionEvents(added.index, [event('two', 'resolve')]);
    assert.deepEqual(resolved.index, [item]); assert.deepEqual(resolved.ids, ['two']);
  });
  await test('only confirmed unavailable and scrub-rejected version PDFs become exceptions', () => {
    const errors = [`${LI}: v3 not available in TIPS`, `${LI} - Test (Requested)/${LI}_v2.pdf: PDF scrub failed (unsupported, damaged, or unreadable PDF); PDF omitted.`, `${LI}: v1 HTTP 503`, `${LI} - Test (Requested)/${LI}_v4.pdf: PDF scrub failed (PDF engine unavailable; reload the extension and TIPS tab); PDF omitted.`, `${LI} - Test (Requested)/Attachments and Links/${LI}_v4.pdf: PDF scrub failed (encrypted PDF); PDF omitted.`];
    const result = Client.classifyErrors(item, errors, AT);
    assert.deepEqual(result.exceptions.map(x => [x.version, x.kind]), [[2,'scrub_failed'],[3,'unavailable']]);
    assert.equal(result.remaining.length, 3); assert(result.remaining.includes(errors[2])); assert(result.remaining.includes(errors[3]));
    assert.equal(Client.classifyErrors(item, [`${LI}: current PDF HTTP 404`], AT).exceptions[0].version, 4);
  });
  await test('excluded gaps and invalid copies leave the actionable scan while the catalogue remains intact', async () => {
    const e = env(), d = directory();
    await d.put(`${LI}/${LI}_v1.pdf`, pdf(1)); await d.put(`${LI}/${LI}_v2.pdf`, 'bad PDF'); await d.put(`${LI}/${LI}_v4.pdf`, pdf(4));
    await e.repo.connect(d);
    const a = await e.repo.inventory({ index: [{ ...item, exceptions: [exception(2,'scrub_failed'), exception(3)] }], done: {} });
    assert.equal(a.summary.indexed, 1); assert.equal(a.summary.requiredDocuments, 1); assert.equal(a.summary.complete, 1);
    assert.equal(a.summary.requiredVersions, 2); assert.equal(a.summary.excludedVersions, 2); assert.equal(a.summary.versionGaps, 0); assert.equal(a.summary.invalidPdfs, 0);
    assert.deepEqual(a.rows[0].missing, []); assert.deepEqual(a.rows[0].invalid, []); assert.equal(a.exceptions.length, 2);
    assert.equal(await d.read(`${LI}/${LI}_v2.pdf`), 'bad PDF'); assert.equal(d.state.writes.length, 0);
  });
  await test('a wholly excluded document is separate from required documents and missing folders', async () => {
    const e = env(); await e.repo.connect(directory());
    const a = await e.repo.inventory({ index: [{ ...item, version: 1, exceptions: [exception(1)] }] });
    assert.equal(a.summary.indexed, 1); assert.equal(a.summary.requiredDocuments, 0); assert.equal(a.summary.fullyExcludedDocuments, 1);
    assert.equal(a.summary.missingTopics, 0); assert.equal(a.rows[0].folderStatus, 'excluded');
  });
  await test('excluded PDFs never hide required attachments when the entire document folder is missing', async () => {
    const e = env(), d = directory(); await e.repo.connect(d);
    const index = [{ ...item, version: 1, exceptions: [exception(1)], attachmentInventory: { at: AT, files: [{ path: 'Attachments and Links/photo.jpg', size: 5, lastModified: 1 }] } }];
    const a = await e.repo.inventory({ index });
    assert.equal(a.rows[0].folderStatus, 'missing'); assert.deepEqual(a.rows[0].missingAttachments, ['Attachments and Links/photo.jpg']);
    assert.equal(a.summary.missingAttachments, 1); assert.equal(a.summary.missingTopics, 1); assert.equal(a.summary.requiredDocuments, 1); assert.equal(a.summary.fullyExcludedDocuments, 0);
    const run = await e.repo.start('repair-attachments', 1, { index }, { includeMissing: true }); assert.equal(run.topics.length, 1);
  });
  await test('upgrade migrates unavailable history and saved scrub errors without losing pending events on restart', async () => {
    const e = env(), d = directory(); for (const v of [1,4]) await d.put(`${LI}/${LI}_v${v}.pdf`, pdf(v));
    await e.repo.connect(d); const connection = await e.db.get('documentsConnection');
    connection.progress[LI] = { version: 4, mdate: item.mdate, ok: false, unavailable: [3], files: [], at: AT };
    await e.db.put('documentsStatus', { epoch: connection.epoch, lastUpdated: AT, summary: { errors: [`${LI}: v3 not available in TIPS`, `${LI} - Test (Requested)/${LI}_v2.pdf: PDF scrub failed (unsupported, damaged, or unreadable PDF); PDF omitted.`] } });
    const a = await e.repo.inventory({ index: [item] });
    assert.equal(a.exceptionEvents.length, 2); assert.equal(a.summary.versionGaps, 0); assert.equal(a.topics[0].last.ok, true);
    const restart = Docs.create({ db: e.db, now: () => AT }), again = await restart.inventory({ index: [item] });
    assert.deepEqual(again.exceptionEvents, a.exceptionEvents); assert.equal(again.summary.complete, 1);
    const applied = CSV.applyExceptionEvents([item], again.exceptionEvents); await restart.ackExceptions(applied.ids);
    const committed = await restart.inventory({ index: applied.index }); assert.deepEqual(committed.exceptionEvents, []); assert.equal(committed.summary.excludedVersions, 2);
  });
  await test('new versions remain required and exception records appear in the inventory CSV', async () => {
    const index = { ...item, version: 5, exceptions: [exception(3)] }, t = { versions: [1,2,4], missingAttachments: [], last: { ok: true, version: 4, mdate: item.mdate } };
    assert.equal(Client.needsUpdate(t, index), true);
    assert.equal(Client.needsUpdate(t, { ...index, version: 4 }), false);
    const e = env(), d = directory(); for (const v of [1,2,4]) await d.put(`${LI}/${LI}_v${v}.pdf`, pdf(v)); await e.repo.connect(d);
    const a = await e.repo.inventory({ index: [index] }), report = Client.csv(a);
    assert.deepEqual(a.rows[0].missing, [5]); assert.match(report, /excluded_versions/); assert.match(report, /unavailable/); assert.match(report, /2026-10-09/);
  });
  await test('future retryable errors remain actionable and can be resolved independently of excluded PDFs', () => {
    const failure = { ...exception(4), kind: 'retryable', reason: 'Attachment HTTP 503' };
    const rows = [{ ...item, exceptions: [exception(3), failure] }];
    const t = { versions: [1,2,4], missingAttachments: [], last: { ok: true, version: 4, mdate: item.mdate } };
    assert.equal(Client.needsUpdate(t, rows[0]), true);
    const fixed = CSV.applyExceptionEvents(rows, [{ ...event('resolved-error','resolve-retryable',4) }]);
    assert.deepEqual(fixed.index[0].exceptions, [exception(3)]);
    assert.equal(Client.needsUpdate(t, fixed.index[0]), false);
  });
  await test('an interrupted update remains visible in the index after migration has already completed', async () => {
    const e = env(), d = directory(); for (let v = 1; v <= 4; v++) await d.put(`${LI}/${LI}_v${v}.pdf`, pdf(v));
    await e.repo.connect(d); await e.repo.inventory({ index: [item] });
    await e.repo.start('interrupted', 1, { index: [item] }); await e.repo.topicStart('interrupted', 1, LI);
    await e.repo.abandon();
    const a = await Docs.create({ db: e.db, now: () => AT }).inventory({ index: [item] });
    assert.equal(a.exceptions.length, 1); assert.equal(a.exceptions[0].kind, 'retryable'); assert.match(a.exceptions[0].reason, /interrupt/i);
    assert.equal(a.summary.excludedVersions, 0); assert.equal(a.summary.requiredVersions, 4);
  });
  await test('local attachment manifests round-trip in the main log with nested relative paths', () => {
    const inventory = { at: AT, files: [{ path: 'Attachments and Links/photo.jpg', size: 20, lastModified: 123 }, { path: 'Attachments and Links/sub/file.txt', size: 12, lastModified: 124 }] };
    const rows = [{ ...item, attachmentInventory: inventory }], text = CSV.stringify(rows);
    assert.match(text.split('\r\n')[0], /attachment_inventory/); assert.deepEqual(CSV.parse(text).index, rows);
    for (const bad of ['../outside.jpg', '/absolute.jpg', 'C:/outside.jpg', 'Attachments and Links/../escape']) {
      assert.throws(() => CSV.normalizeAttachmentInventory({ at: AT, files: [{ path: bad, size: 20, lastModified: 1 }] }), /attachment/i);
    }
  });
  await test('new attachment observations never erase missing files or replace expected sizes', () => {
    const expected = { path: 'Attachments and Links/photo.jpg', size: 20, lastModified: 123 };
    const rows = [{ ...item, attachmentInventory: { at: AT, files: [expected] } }];
    const missing = CSV.applyAttachmentInventories(rows, [{ tips: LI, tipsId: 101, inventory: { at: AT, files: [] } }]);
    assert.deepEqual(missing.index[0].attachmentInventory.files, [expected]);
    const changed = CSV.applyAttachmentInventories(rows, [{ tips: LI, tipsId: 101, inventory: { at: AT, files: [{ ...expected, size: 99 }, { path: 'Attachments and Links/new.jpg', size: 30, lastModified: 124 }] } }]);
    assert.equal(changed.index[0].attachmentInventory.files.find(x => x.path.endsWith('photo.jpg')).size, 20);
    assert.equal(changed.index[0].attachmentInventory.files.length, 2);
  });
  await test('local scan inventories nested attachments and compares the portable manifest without writes', async () => {
    const e = env(), d = directory();
    for (let v = 1; v <= 4; v++) await d.put(`${LI}/${LI}_v${v}.pdf`, pdf(v));
    await d.put(`${LI}/Attachments and Links/photo.jpg`, 'photo'); await d.put(`${LI}/Attachments and Links/nested/notes.txt`, 'notes');
    await e.repo.connect(d); const a = await e.repo.inventory({ index: [item] });
    assert.equal(a.attachmentUpdates[0].inventory.files.length, 2); assert.equal(a.rows[0].attachments, 2);
    const applied = CSV.applyAttachmentInventories([item], a.attachmentUpdates);
    await (await (await d.getDirectoryHandle(LI)).getDirectoryHandle('Attachments and Links')).removeEntry('photo.jpg');
    const next = await e.repo.inventory({ index: applied.index });
    assert.equal(next.summary.missingAttachments, 1); assert.match(next.rows[0].missingAttachments[0], /photo\.jpg/);
    assert.equal(CSV.applyAttachmentInventories(applied.index, next.attachmentUpdates).index[0].attachmentInventory.files.length, 2);
    assert.equal(d.state.writes.length, 0);
  });
  process.exit(process.exitCode || 0);
})();
