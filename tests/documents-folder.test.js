const assert = require('node:assert/strict'), fs = require('node:fs');
const { createHash, webcrypto } = require('node:crypto');
const { directory } = require('./helpers/memory-fs');
globalThis.crypto ||= webcrypto;
if (!fs.existsSync(require('node:path').join(__dirname, '../documents-folder.js'))) { console.log('FAIL document folder inventory and append-only updates are not implemented'); process.exit(1); }
const Docs = require('../documents-folder.js');
const LI = 'LI00.00-P-066047', TOPIC = `Batch 001/${LI} - Old title (Requested)`;
const ITEM = { tips: LI, tipsId: 101, version: 5, title: 'New title', mdate: '2026-10-08' };
const SNAP = { index: [ITEM], done: { 101: { b: 1, d: '2026-10-07', v: 5 } } };
const pdf = v => `%PDF-1.7\nversion ${v}\n%%EOF`;
function env() { const map = new Map(), status = []; return { map, status, repo: Docs.create({ db: { get: async k => map.get(k), put: async (k,v) => map.set(k,v), del: async k => map.delete(k) }, writeStatus: async s => status.push(s) }) }; }
async function ready(extra = {}) { const d = directory(); for (let v = 1; v <= 4; v++) await d.put(`${TOPIC}/${LI}_v${v}.pdf`, pdf(v)); const e = env(); await e.repo.connect(d, extra); const run = await e.repo.start('run-one', 10, SNAP, {}); return { ...e, d, run }; }
async function write(e, path, data, version = 5, tips = LI) {
  const b = Buffer.from(data), f = await e.repo.begin('run-one', 10, { tips, path, version, size: b.length, sha256: createHash('sha256').update(b).digest('hex') });
  if (f.skip) return f;
  for (let i = 0; i < b.length; i += 262144) await e.repo.chunk('run-one', 10, f.upload, i, b.subarray(i, i + 262144).toString('base64'));
  return e.repo.finish('run-one', 10, f.upload);
}
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
(async () => {
  await test('mixed GI and LI archive recognizes GI versions 1 through 11 without a Requested suffix', async () => {
    const e = env(), d = directory('Sorted - Stripped'), gi = 'GI72.12-P-053999', folder = `${gi} - Repair paint blistering on inside of 2nd left`;
    for (let v = 1; v <= 11; v++) await d.put(`${folder}/${gi}_v${v}.pdf`, pdf(v));
    await d.put(`${folder}/Attachments and Links/photo.jpg`, 'old photo');
    await d.put(`${LI} - Odor/${LI}_v1.pdf`, pdf(1));
    const log = { index: [{ tips: gi, tipsId: 102, version: 12, title: 'Repair paint', mdate: '2026-10-09' }, { ...ITEM, version: 1 }], done: { 102: { b: 1, v: 12 }, 101: { b: 2, v: 1 } } };
    await e.repo.connect(d); const a = await e.repo.inventory(log), row = a.rows.find(x => x.tips === gi);
    assert.equal(a.summary.indexed, 2); assert.equal(a.summary.found, 2); assert.equal(a.summary.complete, 1);
    assert.equal(row.path, folder); assert.deepEqual(row.versions, Array.from({ length: 11 }, (_, i) => i + 1)); assert.deepEqual(row.missing, [12]); assert.equal(row.attachments, 1);
    assert.equal(d.state.writes.length, 0);
  });
  await test('GI updates append v12 in the existing folder and retain every older photo and PDF', async () => {
    const e = env(), d = directory('Sorted - Stripped'), gi = 'GI72.12-P-053999', folder = `${gi} - Repair paint blistering on inside of 2nd left`;
    for (let v = 1; v <= 11; v++) await d.put(`${folder}/${gi}_v${v}.pdf`, pdf(v));
    await d.put(`${folder}/Attachments and Links/photo.jpg`, 'old photo');
    await e.repo.connect(d); await e.repo.start('run-one', 10, { index: [{ tips: gi, tipsId: 102, version: 12 }] });
    assert((await write(e, `${gi}_v12.pdf`, pdf(12), 12, gi)).written);
    assert((await write(e, 'Attachments and Links/photo.jpg', 'new photo', 12, gi)).written);
    for (let v = 1; v <= 12; v++) assert.equal(await d.read(`${folder}/${gi}_v${v}.pdf`), pdf(v));
    assert.equal(await d.read(`${folder}/Attachments and Links/photo.jpg`), 'old photo');
    assert.equal(await d.read(`${folder}/Attachments and Links/photo (v12).jpg`), 'new photo');
    await assert.rejects(write(e, `${LI}_v12.pdf`, pdf(12), 12, gi), /path|allowed/i);
  });
  await test('GI identity can be recovered from PDFs when the folder has a custom name', async () => {
    const e = env(), d = directory(), gi = 'GI72.12-P-053999'; await d.put(`Paint repair/${gi}_v11.pdf`, pdf(11));
    await e.repo.connect(d); const a = await e.repo.inventory({ index: [{ ...ITEM, tips: gi, version: 11 }] });
    assert.equal(a.rows[0].path, 'Paint repair'); assert.deepEqual(a.rows[0].versions, [11]); assert.equal(a.summary.extraTopics, 0);
  });
  for (const [name, index, pattern] of [
    ['duplicate number', [ITEM, { ...ITEM, tipsId: 102 }], /entry 2.*duplicate.*LI00\.00-P-066047.*entry 1/i],
    ['invalid version', [{ ...ITEM, version: 0 }], /entry 1.*version.*0.*LI00\.00-P-066047/i],
    ['invalid number', [{ ...ITEM, tips: 'bad-number' }], /entry 1.*document number.*BAD-NUMBER/i]
  ]) await test(`invalid index identifies the entry and reason: ${name}`, async () => {
    const e = env(); await e.repo.connect(directory()); await assert.rejects(e.repo.inventory({ index }), pattern);
  });
  await test('inventory matches LI identities in nested folders and distinguishes log discrepancies', async () => {
    const e = env(), d = directory(), b = 'LI20.10-P-075374', c = 'LI40.10-P-070001', dup = 'LI50.10-P-070001', extra = 'LI60.10-P-070001';
    await d.put(`${TOPIC}/${LI}_v1.pdf`, pdf(1)); await d.put(`${TOPIC}/${LI}_v2.pdf`, ''); await d.put(`${TOPIC}/${LI}_v4.pdf`, pdf(4));
    await d.put(`First/${dup}/${dup}_v1.pdf`, pdf(1)); await d.put(`Second/${dup}/${dup}_v1.pdf`, pdf(1)); await d.put(`${extra}/${extra}_v1.pdf`, pdf(1));
    await e.repo.connect(d);
    const a = await e.repo.inventory({ index: [ITEM, { ...ITEM, tips: b, tipsId: 102 }, { ...ITEM, tips: c, tipsId: 103 }, { ...ITEM, tips: dup, tipsId: 104 }], done: { ...SNAP.done, 102: { b: 1, v: 5 } } });
    const row = a.rows.find(x => x.tips === LI); assert.equal(row.path, TOPIC); assert.deepEqual(row.versions, [1,4]); assert.deepEqual(row.missing, [2,3,5]); assert.deepEqual(row.invalid, [2]);
    assert.equal(a.summary.missingTopics, 2); assert.equal(a.summary.missingExported, 1); assert.equal(a.summary.pendingNotSaved, 1); assert.equal(a.summary.duplicateTopics, 1); assert.equal(a.summary.extraTopics, 1);
    assert.match(a.attachmentNote, /TIPS/); assert.equal(d.state.writes.length, 0);
  });
  await test('v5 is appended to the original topic folder while v1 through v4 remain byte-for-byte intact', async () => {
    const e = await ready(); const result = await write(e, `${LI}_v5.pdf`, pdf(5)); assert.equal(result.written, true);
    for (let v = 1; v <= 5; v++) assert.equal(await e.d.read(`${TOPIC}/${LI}_v${v}.pdf`), pdf(v));
    assert.equal(e.d.state.writes.length, 1); assert.equal(e.run.topics[0].path, TOPIC);
  });
  await test('an existing PDF is never replaced by different downloaded bytes', async () => {
    const e = await ready(); assert.equal((await write(e, `${LI}_v4.pdf`, pdf('different'), 4)).skip, true);
    assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`), pdf(4)); assert.equal(e.d.state.writes.length, 0);
  });
  await test('changed attachments get versioned siblings and identical older variants are reused', async () => {
    const e = await ready(); await e.d.put(`${TOPIC}/Attachments and Links/photo.jpg`, 'old photo');
    const a = await write(e, 'Attachments and Links/photo.jpg', 'new photo'); assert.equal(a.path, 'Attachments and Links/photo (v5).jpg');
    assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo.jpg`), 'old photo');
    assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo (v5).jpg`), 'new photo');
    assert.equal((await write(e, 'Attachments and Links/photo.jpg', 'new photo', 6)).skip, true); assert.equal(e.d.state.writes.length, 1);
  });
  await test('two attachment revisions within the same LI version both survive', async () => {
    const e = await ready(); await e.d.put(`${TOPIC}/Attachments and Links/file.bin`, 'old');
    await write(e, 'Attachments and Links/file.bin', 'revision A'); const b = await write(e, 'Attachments and Links/file.bin', 'revision B');
    assert.equal(b.path, 'Attachments and Links/file (v5-2).bin'); assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/file (v5).bin`), 'revision A');
  });
  await test('custom attachment directory is honored without altering unrelated files', async () => {
    const e = await ready({ attachmentFolder: 'Photos and files' }); await e.d.put(`${TOPIC}/notes.txt`, 'my notes');
    await write(e, 'Attachments and Links/photo.jpg', 'photo'); assert.equal(await e.d.read(`${TOPIC}/Photos and files/photo.jpg`), 'photo'); assert.equal(await e.d.read(`${TOPIC}/notes.txt`), 'my notes');
  });
  await test('missing LI folders are planned only when explicitly included', async () => {
    const e = env(), d = directory(); await e.repo.connect(d);
    assert.equal((await e.repo.start('a', 1, SNAP, {})).topics.length, 0); await e.repo.end('a', 1, {});
    const r = await e.repo.start('b', 1, SNAP, { includeMissing: true }); assert.equal(r.topics.length, 1); assert.equal(r.topics[0].create, true); assert.match(r.topics[0].path, /^LI00.00-P-066047 - New title$/);
    assert.deepEqual(SNAP.done, { 101: { b: 1, d: '2026-10-07', v: 5 } });
  });
  await test('duplicate LI folders are excluded from updates', async () => {
    const e = env(), d = directory(); await d.put(`${LI}/${LI}_v1.pdf`, pdf(1)); await d.put(`Other/${LI}/${LI}_v1.pdf`, pdf(1)); await e.repo.connect(d);
    const r = await e.repo.start('a', 1, SNAP, { includeMissing: true }); assert.equal(r.topics.length, 0); assert.equal(r.inventory.summary.duplicateTopics, 1);
  });
  await test('traversal and files belonging to an unplanned LI are rejected', async () => {
    const e = await ready(); await assert.rejects(write(e, '../escape.pdf', 'bad'), /path|filename|allowed/i);
    await assert.rejects(write(e, 'Attachments and Links/../../escape', 'bad'), /path|filename|allowed/i);
    await assert.rejects(write(e, `${LI}_v5.pdf`, pdf(5), 5, 'LI99.99-P-999999'), /topic|planned/i);
    await assert.rejects(e.repo.connect(e.d, { attachmentFolder: '../unsafe' }), /folder|filename/i);
  });
  await test('lease ownership and source changes cannot redirect an active update', async () => {
    const e = await ready(); await assert.rejects(e.repo.start('other', 11, SNAP, {}), /running|active/i);
    await assert.rejects(e.repo.end('run-one', 11, {}), /owner|tab|update/i);
    await assert.rejects(e.repo.disconnect(), /running|active/i);
    await e.repo.abandon(); await e.repo.connect(directory()); await assert.rejects(write(e, `${LI}_v5.pdf`, pdf(5)), /expired|active|update/i);
  });
  await test('permission loss blocks folder updates without modifying old files', async () => {
    const e = await ready(); e.d.state.permission = 'prompt'; await assert.rejects(write(e, `${LI}_v5.pdf`, pdf(5)), /access|permission/i);
    assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`), pdf(4));
  });
  await test('out-of-order chunks are rejected and cancellation removes only its new uncommitted placeholder', async () => {
    const e = await ready(), bytes = Buffer.from(pdf(5));
    const f = await e.repo.begin('run-one', 10, { tips: LI, path: `${LI}_v5.pdf`, version: 5, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await assert.rejects(e.repo.chunk('run-one', 10, f.upload, 10, bytes.toString('base64')), /order|offset/i);
    await e.repo.end('run-one', 10, { cancelled: true }); await assert.rejects(e.d.read(`${TOPIC}/${LI}_v5.pdf`), /NotFound/);
    assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`), pdf(4));
  });
  await test('failed close never claims success or changes an existing attachment', async () => {
    const e = await ready(); await e.d.put(`${TOPIC}/Attachments and Links/photo.jpg`, 'old'); e.d.state.failClose = true;
    await assert.rejects(write(e, 'Attachments and Links/photo.jpg', 'new')); await e.repo.end('run-one', 10, { errors: ['write failed'] });
    assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo.jpg`), 'old'); assert.equal(e.status.at(-1).phase, 'error');
  });
  await test('empty or invalid existing PDFs are reported and preserved for manual correction', async () => {
    const e = await ready(); await e.d.put(`${TOPIC}/${LI}_v5.pdf`, 'not a PDF');
    await assert.rejects(write(e, `${LI}_v5.pdf`, pdf(5)), /invalid|PDF/i); assert.equal(await e.d.read(`${TOPIC}/${LI}_v5.pdf`), 'not a PDF');
  });
  await test('worker restart recovers uncommitted placeholders without losing saved files', async () => {
    const e = await ready(), b = Buffer.from(pdf(5));
    const f = await e.repo.begin('run-one', 10, { tips: LI, path: `${LI}_v5.pdf`, version: 5, size: b.length, sha256: createHash('sha256').update(b).digest('hex') });
    await e.repo.chunk('run-one', 10, f.upload, 0, b.toString('base64'));
    const restarted = Docs.create({ db: { get: async k => e.map.get(k), put: async (k,v) => e.map.set(k,v), del: async k => e.map.delete(k) } });
    await assert.rejects(restarted.finish('run-one', 10, f.upload), /complete|expired/i);
    await restarted.abandon(); await assert.rejects(e.d.read(`${TOPIC}/${LI}_v5.pdf`), /NotFound/);
    const run = await restarted.start('retry', 10, SNAP, {}); assert.deepEqual(run.topics[0].invalid, []); assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`), pdf(4));
  });
  await test('failure opening a writer cleans only its new empty placeholder', async () => {
    const e = await ready(); e.d.state.failOpen = true;
    await assert.rejects(write(e, `${LI}_v5.pdf`, pdf(5)), /Modification/);
    await e.repo.end('run-one', 10, { errors: ['open failed'] });
    await assert.rejects(e.d.read(`${TOPIC}/${LI}_v5.pdf`), /NotFound/);
    assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`), pdf(4));
  });
  await test('permission loss still releases the update lease so access can be renewed', async () => {
    const e = await ready(); e.d.state.permission = 'prompt';
    await e.repo.end('run-one', 10, { errors: ['Permission lost'] }); assert.equal(await e.repo.active(), undefined);
    e.d.state.permission = 'granted'; assert.equal((await e.repo.start('retry', 10, SNAP, {})).topics.length, 1);
  });
  await test('loose PDFs cannot hide nested LI folders or select a mixed container as a write destination', async () => {
    const e = env(), d = directory(), other = 'LI20.10-P-075374';
    await d.put(`Batch/${LI}_v1.pdf`, pdf(1));
    await d.put(`Batch/${LI}/${LI}_v1.pdf`, pdf(1));
    await d.put(`Batch/${other}/${other}_v1.pdf`, pdf(1));
    await e.repo.connect(d);
    const snapshot = { index: [{ ...ITEM, version: 1 }, { ...ITEM, tips: other, tipsId: 102, version: 1 }], done: {} };
    let r = await e.repo.start('mixed', 1, snapshot, { includeMissing: true });
    assert.equal(r.inventory.summary.duplicateTopics, 1); assert.equal(r.inventory.summary.missingTopics, 0);
    assert.deepEqual(r.topics.map(t => t.path), [`Batch/${other}`]);
    await e.repo.end('mixed', 1, {});
    // Even without a duplicate of the loose PDF, a container is not a safe LI destination.
    await (await d.getDirectoryHandle('Batch')).removeEntry(LI);
    r = await e.repo.start('mixed-two', 1, snapshot, { includeMissing: true });
    assert.equal(r.inventory.rows.find(x => x.tips === LI).folderStatus, 'ambiguous');
    assert.deepEqual(r.topics.map(t => t.path), [`Batch/${other}`]);
  });
  await test('corrupt saved versions beyond the index and duplicate case variants remain discrepancies', async () => {
    const e = env(), d = directory(); await d.put(`${LI}/${LI}_v1.pdf`, pdf(1)); await d.put(`${LI}/${LI}_v2.pdf`, 'corrupt');
    await e.repo.connect(d); const snapshot = { index: [{ ...ITEM, version: 1 }], done: {} };
    let a = await e.repo.inventory(snapshot); assert.equal(a.summary.complete, 0); assert.equal(a.rows[0].folderStatus, 'incomplete'); assert.deepEqual(a.rows[0].invalid, [2]);
    await (await d.getDirectoryHandle(LI)).removeEntry(`${LI}_v2.pdf`); await d.put(`${LI}/${LI.toLowerCase()}_v1.pdf`, 'corrupt');
    a = await e.repo.inventory(snapshot); assert.equal(a.summary.complete, 0); assert.deepEqual(a.rows[0].invalid, [1]);
  });
  process.exit(process.exitCode || 0);
})();
