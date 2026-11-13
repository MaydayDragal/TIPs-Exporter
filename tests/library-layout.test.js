// LI Library layout (the folder LI Organizer builds): the newest version of a document sits in its folder,
// earlier versions are in a subfolder, and document folders live inside group folders such as
// "54 Electrical and instruments". These checks cover scanning that layout, filing the previous version when a
// new one arrives, and where a brand-new document is created.
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { directory } = require('./helpers/memory-fs');
globalThis.crypto ||= webcrypto;
const Docs = require('../documents-folder.js');
const LI = 'LI54.71-P-080956', GROUP = '54 Electrical and instruments', FOLDER = `${GROUP}/${LI} - Driver Assistance System Limited`;
const OLD = 'Older versions', LIB = { olderFolder: OLD };
const item = (version, extra = {}) => ({ tips: LI, tipsId: 101, version, title: 'Driver Assistance System Limited', mdate: '2026-11-12', ...extra });
const pdf = (v, tips = LI) => `%PDF-1.7\n${tips} version ${v}\n%%EOF`;
function env() { const map = new Map(); return { map, repo: Docs.create({ db: { get: async k => map.get(k), put: async (k, v) => map.set(k, v), del: async k => map.delete(k) }, writeStatus: async () => {} }) }; }
// A library folder holding one document: `top` versions beside each other, `older` versions in the subfolder.
async function library(top, older, name = FOLDER) {
  const d = directory('LI Library');
  for (const v of top) await d.put(`${name}/${LI}_v${v}.pdf`, pdf(v));
  for (const v of older) await d.put(`${name}/${OLD}/${LI}_v${v}.pdf`, pdf(v));
  return d;
}
const has = async (d, path) => { try { await d.read(path); return true; } catch (_) { return false; } };
async function write(e, path, data, version, tips = LI) {
  const b = Buffer.from(data), f = await e.repo.begin('run-one', 10, { tips, path, version, size: b.length, sha256: createHash('sha256').update(b).digest('hex') });
  if (f.skip) return f;
  for (let i = 0; i < b.length; i += 262144) await e.repo.chunk('run-one', 10, f.upload, i, b.subarray(i, i + 262144).toString('base64'));
  return e.repo.finish('run-one', 10, f.upload);
}
const done = (e, version, tips = LI) => e.repo.topicDone('run-one', 10, { tips, version, mdate: '2026-11-12', ok: true });
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
(async () => {
  await test('a library folder scans as one complete document: newest on top, earlier versions in the subfolder', async () => {
    const e = env(), d = await library([5], [1, 2, 3, 4]);
    await d.put(`${FOLDER}/Attachments and Links/photo.png`, 'photo');
    await d.put(`${FOLDER}/Revision History/revision_history.csv`, 'v1,v2');
    await e.repo.connect(d, LIB);
    const a = await e.repo.inventory({ index: [item(5)], done: {} }), row = a.rows[0];
    assert.equal(row.folderStatus, 'present'); assert.deepEqual(row.versions, [1, 2, 3, 4, 5]); assert.deepEqual(row.missing, []);
    assert.equal(row.path, FOLDER); assert.equal(row.attachments, 1);
    assert.equal(a.summary.complete, 1); assert.equal(a.summary.duplicateTopics, 0); assert.equal(a.summary.ambiguousTopics, 0);
    assert.equal(d.state.writes.length, 0);
  });
  await test('without the setting the same folder is not misread silently: it is reported, not updated', async () => {
    const e = env(), d = await library([5], [1, 2, 3, 4]);
    await e.repo.connect(d);
    const a = await e.repo.inventory({ index: [item(5)], done: {} });
    assert.notEqual(a.rows[0].folderStatus, 'present');
    assert.equal((await e.repo.status()).olderFolder, '');
  });
  await test('a new version goes on top and the previous one is filed under earlier versions', async () => {
    const e = env(), d = await library([5], [1, 2, 3, 4]);
    await e.repo.connect(d, LIB);
    const run = await e.repo.start('run-one', 10, { index: [item(6)], done: {} }, {});
    assert.deepEqual(run.inventory.rows[0].missing, [6]);
    assert((await write(e, `${LI}_v6.pdf`, pdf(6), 6)).written);
    assert.equal(await d.read(`${FOLDER}/${LI}_v6.pdf`), pdf(6));
    assert.equal(await d.read(`${FOLDER}/${LI}_v5.pdf`), pdf(5));           // not moved until the document is finished
    const r = await done(e, 6);
    assert.equal(r.filed, 1);
    assert.equal(await d.read(`${FOLDER}/${LI}_v6.pdf`), pdf(6));
    assert.equal(await d.read(`${FOLDER}/${OLD}/${LI}_v5.pdf`), pdf(5));
    assert.equal(await has(d, `${FOLDER}/${LI}_v5.pdf`), false);
    for (const v of [1, 2, 3, 4]) assert.equal(await d.read(`${FOLDER}/${OLD}/${LI}_v${v}.pdf`), pdf(v));
    await e.repo.end('run-one', 10, {});
    const again = await e.repo.inventory({ index: [item(6)], done: {} });
    assert.equal(again.rows[0].folderStatus, 'present'); assert.deepEqual(again.rows[0].versions, [1, 2, 3, 4, 5, 6]);
  });
  await test('a version already filed under earlier versions is not downloaded again', async () => {
    const e = env(), d = await library([5], [1, 2, 3, 4]);
    await e.repo.connect(d, LIB); await e.repo.start('run-one', 10, { index: [item(5)], done: {} }, {});
    const r = await write(e, `${LI}_v3.pdf`, pdf(3), 3);
    assert.equal(r.skip, true); assert.equal(d.state.writes.length, 0);
    assert.equal(await has(d, `${FOLDER}/${LI}_v3.pdf`), false);
  });
  await test('a missing earlier version is downloaded and filed, and the newest stays on top', async () => {
    const e = env(), d = await library([5], [1, 2, 4]);
    await e.repo.connect(d, LIB);
    const run = await e.repo.start('run-one', 10, { index: [item(5)], done: {} }, {});
    assert.deepEqual(run.inventory.rows[0].missing, [3]);
    assert((await write(e, `${LI}_v3.pdf`, pdf(3), 3)).written);
    assert.equal((await done(e, 5)).filed, 1);
    assert.equal(await d.read(`${FOLDER}/${OLD}/${LI}_v3.pdf`), pdf(3));
    assert.equal(await d.read(`${FOLDER}/${LI}_v5.pdf`), pdf(5));
    assert.equal(await has(d, `${FOLDER}/${LI}_v3.pdf`), false);
  });
  await test('the details file of the previous version moves with it, and the subfolder is created when needed', async () => {
    const e = env(), d = await library([5], []);
    await d.put(`${FOLDER}/${LI}_v5.json`, '{"version":5}');
    await e.repo.connect(d, LIB); await e.repo.start('run-one', 10, { index: [item(6, { exceptions: [1, 2, 3, 4].map(version => ({ version, kind: 'unavailable', reason: 'Version not available in TIPS', at: '2026-11-12T00:00:00.000Z' })) })], done: {} }, {});
    assert((await write(e, `${LI}_v6.pdf`, pdf(6), 6)).written);
    assert.equal((await done(e, 6)).filed, 2);
    assert.equal(await d.read(`${FOLDER}/${OLD}/${LI}_v5.pdf`), pdf(5));
    assert.equal(await d.read(`${FOLDER}/${OLD}/${LI}_v5.json`), '{"version":5}');
    assert.equal(await has(d, `${FOLDER}/${LI}_v5.json`), false);
  });
  await test('attachments still go to the attachment folder, and existing ones are kept', async () => {
    const e = env(), d = await library([5], [1, 2, 3, 4]);
    await d.put(`${FOLDER}/Attachments and Links/photo.png`, 'old photo');
    await e.repo.connect(d, LIB); await e.repo.start('run-one', 10, { index: [item(6)], done: {} }, {});
    assert((await write(e, `${LI}_v6.pdf`, pdf(6), 6)).written);
    assert((await write(e, 'Attachments and Links/photo.png', 'new photo', 6)).written);
    assert((await write(e, 'Attachments and Links/wiring.jpg', 'wiring', 6)).written);
    await done(e, 6);
    assert.equal(await d.read(`${FOLDER}/Attachments and Links/photo.png`), 'old photo');
    assert.equal(await d.read(`${FOLDER}/Attachments and Links/photo (v6).png`), 'new photo');
    assert.equal(await d.read(`${FOLDER}/Attachments and Links/wiring.jpg`), 'wiring');
  });
  await test('an attachment LI Organizer kept as "name (2).pdf" is the expected file, not a missing one', async () => {
    const e = env(), d = await library([5], [1, 2, 3, 4]);
    await d.put(`${FOLDER}/Attachments and Links/guide.pdf`, 'the original download, with its metadata');
    await d.put(`${FOLDER}/Attachments and Links/guide (2).pdf`, 'the cleaned copy');
    const expected = { at: '2026-10-12T11:00:22.833Z', files: [{ path: 'Attachments and Links/guide.pdf', size: 16, lastModified: 1 }] };
    await e.repo.connect(d, LIB);
    const a = await e.repo.inventory({ index: [item(5, { attachmentInventory: expected })], done: {} });
    assert.deepEqual(a.rows[0].missingAttachments, []); assert.equal(a.rows[0].folderStatus, 'present'); assert.equal(a.summary.missingAttachments, 0);
    const other = await e.repo.inventory({ index: [item(5, { attachmentInventory: { ...expected, files: [{ path: 'Attachments and Links/guide.pdf', size: 99, lastModified: 1 }] } })], done: {} });
    assert.deepEqual(other.rows[0].missingAttachments, ['Attachments and Links/guide.pdf']);          // a size nothing has is still reported
    // A copy saved under a version name and later cleared away as a duplicate is still covered by the copy that stays.
    const versioned = await e.repo.inventory({ index: [item(5, { attachmentInventory: { ...expected, files: [{ path: 'Attachments and Links/guide (v5).pdf', size: 16, lastModified: 1 }, { path: 'Attachments and Links/guide (2).pdf', size: 16, lastModified: 1 }] } })], done: {} });
    assert.deepEqual(versioned.rows[0].missingAttachments, []);
    await e.repo.start('run-one', 10, { index: [item(5)], done: {} }, {});
    const r = await write(e, 'Attachments and Links/guide.pdf', 'the cleaned copy', 5);
    assert.equal(r.skip, true); assert.equal(r.path, 'Attachments and Links/guide (2).pdf'); assert.equal(d.state.writes.length, 0);   // not saved a third time
  });
  await test('two different files with one name are both kept where they are', async () => {
    const e = env(), d = await library([4, 5], [1, 2, 3]);
    await d.put(`${FOLDER}/${OLD}/${LI}_v4.pdf`, '%PDF-1.7\nanother copy of version 4\n%%EOF');
    await e.repo.connect(d, LIB); await e.repo.start('run-one', 10, { index: [item(5)], done: {} }, {});
    assert.equal((await done(e, 5)).filed, 0);
    assert.equal(await d.read(`${FOLDER}/${LI}_v4.pdf`), pdf(4));
    assert.equal(await d.read(`${FOLDER}/${OLD}/${LI}_v4.pdf`), '%PDF-1.7\nanother copy of version 4\n%%EOF');
  });
  await test('an identical copy already filed, or an empty leftover from an interrupted move, is settled', async () => {
    const e = env(), d = await library([3, 4, 5], [1, 2]);
    await d.put(`${FOLDER}/${OLD}/${LI}_v4.pdf`, pdf(4));     // identical: only the copy on top is removed
    await d.put(`${FOLDER}/${OLD}/${LI}_v3.pdf`, '');         // empty leftover: replaced
    await e.repo.connect(d, LIB); await e.repo.start('run-one', 10, { index: [item(5)], done: {} }, {});
    assert.equal((await done(e, 5)).filed, 2);
    assert.equal(await d.read(`${FOLDER}/${OLD}/${LI}_v3.pdf`), pdf(3));
    assert.equal(await d.read(`${FOLDER}/${OLD}/${LI}_v4.pdf`), pdf(4));
    assert.equal(await has(d, `${FOLDER}/${LI}_v3.pdf`), false); assert.equal(await has(d, `${FOLDER}/${LI}_v4.pdf`), false);
    assert.equal(await d.read(`${FOLDER}/${LI}_v5.pdf`), pdf(5));
  });
  await test('an invalid PDF beside the newest version is left for you to deal with', async () => {
    const e = env(), d = await library([5], [1, 2, 3]);
    await d.put(`${FOLDER}/${LI}_v4.pdf`, 'not a pdf');
    await e.repo.connect(d, LIB); await e.repo.start('run-one', 10, { index: [item(5)], done: {} }, {});
    assert.equal((await done(e, 5)).filed, 0);
    assert.equal(await d.read(`${FOLDER}/${LI}_v4.pdf`), 'not a pdf');
  });
  await test('a new document is created in its group folder, named like LI Organizer names it', async () => {
    const e = env(), d = await library([5], [1, 2, 3, 4]);
    await d.put('27/keep.txt', 'an existing group folder without a name');
    const fresh = [{ tips: 'LI54.10-P-000001', tipsId: 201, version: 1, title: 'Battery: discharged / "no start"' },
      { tips: 'LI27.00-P-000002', tipsId: 202, version: 1, title: 'Harsh shift' },
      { tips: 'LI83.30-P-000003', tipsId: 203, version: 1, title: 'A/C leak' },
      { tips: 'LI06.00-P-000004', tipsId: 204, version: 1, title: '' }];
    await e.repo.connect(d, LIB);
    const run = await e.repo.start('run-one', 10, { index: [item(5), ...fresh], done: {} }, { includeMissing: true });
    const path = tips => run.topics.find(t => t.tips === tips).path;
    assert.equal(path('LI54.10-P-000001'), `${GROUP}/LI54.10-P-000001 - Battery_ discharged _ _no start`);   // existing group folder reused
    assert.equal(path('LI27.00-P-000002'), '27/LI27.00-P-000002 - Harsh shift');                               // existing unnamed group folder reused
    assert.equal(path('LI83.30-P-000003'), '83 Climate control/LI83.30-P-000003 - A_C leak');                  // new group folder, named
    assert.equal(path('LI06.00-P-000004'), '06/LI06.00-P-000004');                                             // group without a known name
    assert((await write(e, 'LI83.30-P-000003_v1.pdf', pdf(1, 'LI83.30-P-000003'), 1, 'LI83.30-P-000003')).written);
    assert((await write(e, 'Attachments and Links/leak.jpg', 'leak', 1, 'LI83.30-P-000003')).written);
    assert.equal((await done(e, 1, 'LI83.30-P-000003')).filed, 0);
    assert.equal(await d.read('83 Climate control/LI83.30-P-000003 - A_C leak/LI83.30-P-000003_v1.pdf'), pdf(1, 'LI83.30-P-000003'));
    assert.equal(await d.read('83 Climate control/LI83.30-P-000003 - A_C leak/Attachments and Links/leak.jpg'), 'leak');
  });
  await test('an archive without group folders gets a new document directly in the selected folder', async () => {
    const e = env(), d = await library([5], [1, 2, 3, 4], `${LI} - Driver Assistance System Limited`);
    await e.repo.connect(d, LIB);
    const run = await e.repo.start('run-one', 10, { index: [item(5), { tips: 'LI83.30-P-000003', tipsId: 203, version: 1, title: 'A/C leak' }], done: {} }, { includeMissing: true });
    assert.equal(run.topics.find(t => t.tips === 'LI83.30-P-000003').path, 'LI83.30-P-000003 - A_C leak');
    const empty = env(), blank = directory('New library');
    await empty.repo.connect(blank, LIB);
    const first = await empty.repo.start('run-one', 10, { index: [{ tips: 'LI83.30-P-000003', tipsId: 203, version: 1, title: 'A/C leak' }], done: {} }, { includeMissing: true });
    assert.equal(first.topics[0].path, '83 Climate control/LI83.30-P-000003 - A_C leak');                      // an empty folder starts with group folders
  });
  await test('folder names: long titles are cut at a word, and the setting is validated and remembered', async () => {
    const long = 'Instrument cluster message for the driver assistance systems appears although every function works as it should';
    const name = Docs.libraryFolder({ tips: 'li54.71-p-080956', title: long });
    assert.match(name, /^LI54\.71-P-080956 - Instrument cluster message/); assert(name.length <= 19 + 90 && !/[ .\-_,]$/.test(name));
    assert.equal(Docs.libraryFolder({ tips: LI, title: '' }), LI);
    assert.equal(Docs.groupFolder('LI98.10-P-000001', []), '98 Paint'); assert.equal(Docs.groupFolder('LI98.10-P-000001', ['98 Lack', '98']), '98');
    const e = env(), d = await library([5], [1]);
    await assert.rejects(e.repo.connect(d, { olderFolder: 'Attachments and Links' }), /different names/);
    await assert.rejects(e.repo.connect(d, { olderFolder: 'bad/name' }), /Invalid folder or filename/);
    assert.equal((await e.repo.connect(d, LIB)).olderFolder, OLD);
    assert.equal((await e.repo.configure({ pollMinutes: 15 })).olderFolder, OLD);          // settings that don't mention it keep it
    assert.equal((await e.repo.configure({ olderFolder: 'Earlier' })).olderFolder, 'Earlier');
    assert.equal((await e.repo.configure({ olderFolder: '' })).olderFolder, '');            // switched off again
  });
})();
