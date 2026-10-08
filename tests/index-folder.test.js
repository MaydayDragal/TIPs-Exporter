const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.join(__dirname, '..');
if (!fs.existsSync(path.join(root, 'index-folder.js')) || !fs.existsSync(path.join(root, 'index-csv.js'))) {
  console.log('FAIL folder-backed index repository is not implemented'); process.exit(1);
}
const CSV = require('../index-csv.js'), Folder = require('../index-folder.js');
const NAME = '_progress_log_all_documents.csv';
const A = { tips: 'LI00.00-P-066047', tipsId: 101, version: 7, title: 'Odor, "crayon"', mdate: '2026-10-07' };
const B = { tips: 'LI20.10-P-075374', tipsId: 102, version: 2, title: '=1+2', mdate: '2026-10-06' };
const state = (done = false) => ({ index: [A, B], done: done ? { 101: { b: 4, v: 7, d: '2026-10-07T18:30:00Z' } } : {} });
const error = name => Object.assign(new Error(name), { name });
function directory(files = {}) {
  const d = { name: 'TIPS progress', files: { ...files }, permission: 'granted', writes: [], failWrite: false,
    async queryPermission() { return this.permission; },
    async getFileHandle(name, options = {}) {
      if (!(name in d.files) && !options.create) throw error('NotFoundError');
      return { async getFile() { if (!(name in d.files)) throw error('NotFoundError'); return { size: d.files[name].length, text: async () => d.files[name] }; },
        async createWritable() { let text; return { async write(value) { if (d.failWrite) throw error('NoModificationAllowedError'); text = value; },
          async close() { d.files[name] = text; d.writes.push(name); }, async abort() {} }; } };
    }
  }; return d;
}
function env(initial = state(), record = null) {
  const box = { state: structuredClone(initial), record, status: null, changes: 0 };
  const deps = { readRecord: async () => box.record, writeRecord: async r => { box.record = r; },
    readState: async () => structuredClone(box.state), writeState: async s => { box.state = structuredClone(s); box.changes++; },
    writeStatus: async s => { box.status = structuredClone(s); }, now: () => '2026-10-07T18:35:00Z', newEpoch: () => 'epoch-' + ++env.id };
  return { box, repo: Folder.create(deps), restart: () => Folder.create(deps) };
}
env.id = 0;
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
(async () => {
  await test('CSV keeps index order, exported versions and quoted/formula-safe titles', () => {
    const text = CSV.stringify(state(true).index, state(true).done), parsed = CSV.parse(text);
    assert.deepEqual(parsed, state(true)); assert(text.includes('"\'=1+2"'));
    assert.deepEqual(CSV.parse(CSV.stringify([], {})), { index: [], done: {} });
    assert.deepEqual(CSV.parse(text + '\r\n\r\n",,,,,,,,"\r\n'), state(true), 'Legacy spreadsheet separator-only rows are empty, not topics');
    assert.throws(() => CSV.parse(text + '\r\n"partial topic"'), /columns/i);
    assert.throws(() => CSV.parse('wrong,header\n1,2'), /index|progress|CSV/i);
    assert.throws(() => CSV.parse(text + '\r\n' + text.split('\r\n')[1]), /duplicate/i);
    assert.throws(() => CSV.parse(text.replace('"pending"', '"nonsense"')), /status/i);
    assert.throws(() => CSV.parse(text + '\r\n"unclosed'), /quote/i);
  });
  await test('connecting an existing index restores it without overwriting it with browser cache', async () => {
    const original = CSV.stringify(state(true).index, state(true).done), d = directory({ [NAME]: original }), e = env({ index: [], done: {} });
    const r = await e.repo.connect(d, NAME);
    assert(r.ok); assert.deepEqual(e.box.state, state(true)); assert.equal(d.files[NAME], original); assert.equal(d.writes.length, 0);
    assert.equal(e.box.status.phase, 'saved'); assert.equal(e.box.status.folderName, 'TIPS progress');
  });
  await test('connecting an empty folder creates the CSV from existing browser progress', async () => {
    const d = directory(), e = env(state(true)); await e.repo.connect(d, NAME);
    assert.deepEqual(CSV.parse(d.files[NAME]), state(true)); assert.equal(d.writes.length, 1);
  });
  await test('automatic save updates the same index only after a progress commit', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME);
    const r = await e.repo.save(state(true), e.box.status.epoch);
    assert(r.ok); assert.deepEqual(CSV.parse(d.files[NAME]), state(true)); assert.equal(d.writes.length, 2);
  });
  await test('permission loss retains committed progress locally and reconnect saves it on restart', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME); const before = d.files[NAME];
    d.permission = 'prompt'; const r = await e.repo.save(state(true), e.box.status.epoch);
    assert(!r.ok); assert.equal(e.box.status.phase, 'permission'); assert.deepEqual(e.box.state, state(true)); assert.equal(d.files[NAME], before);
    d.permission = 'granted'; assert((await e.restart().load()).ok); assert.deepEqual(CSV.parse(d.files[NAME]), state(true));
  });
  await test('failed writes do not change disk, claim success, or lose the pending browser copy', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME); const before = d.files[NAME]; d.failWrite = true;
    const r = await e.repo.save(state(true), e.box.status.epoch);
    assert(!r.ok); assert.equal(e.box.status.phase, 'error'); assert.equal(d.files[NAME], before); assert.deepEqual(e.box.state, state(true));
  });
  await test('startup adopts external progress when the local copy is unchanged', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME);
    d.files[NAME] = CSV.stringify(state(true).index, state(true).done);
    assert((await e.restart().load()).ok); assert.deepEqual(e.box.state, state(true));
  });
  await test('conflicting external edits never overwrite either copy', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME);
    const external = { index: [A, { ...B, version: 3 }], done: {} }; d.files[NAME] = CSV.stringify(external.index, external.done);
    const r = await e.repo.save(state(true), e.box.status.epoch);
    assert(!r.ok); assert.equal(e.box.status.phase, 'conflict'); assert.deepEqual(CSV.parse(d.files[NAME]), external); assert.deepEqual(e.box.state, state(true));
  });
  await test('missing or corrupted configured files are not silently recreated or imported', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME); delete d.files[NAME];
    assert(!(await e.repo.load()).ok); assert(!(NAME in d.files)); assert.deepEqual(e.box.state, state());
    d.files[NAME] = 'unrelated CSV'; assert(!(await e.repo.load()).ok); assert.deepEqual(e.box.state, state());
  });
  await test('invalid new source leaves the existing connection and both indexes untouched', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME); const epoch = e.box.status.epoch;
    const bad = directory({ [NAME]: 'not an index' }); await assert.rejects(e.repo.connect(bad, NAME));
    assert.equal(e.box.record.epoch, epoch); assert.deepEqual(e.box.state, state()); assert.equal(bad.writes.length, 0);
    await assert.rejects(e.repo.connect(d, '../outside.csv')); assert.equal(e.box.record.epoch, epoch);
  });
  await test('a stale tab cannot save into a newly selected folder or replace its browser state', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME); const oldEpoch = e.box.status.epoch;
    const other = directory({ [NAME]: CSV.stringify([B], {}) }); await e.repo.connect(other, NAME);
    const r = await e.repo.save(state(true), oldEpoch);
    assert(!r.ok); assert.equal(r.stale, true); assert.deepEqual(e.box.state, { index: [B], done: {} }); assert.equal(other.writes.length, 0);
  });
  await test('stale progress from another tab cannot overwrite a more recent approved batch', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME); const epoch = e.box.status.epoch;
    const base = CSV.stringify(state().index, state().done);
    assert((await e.repo.save(state(true), epoch, base)).ok);
    const r = await e.repo.save(state(), epoch, base);
    assert(r.stale); assert.deepEqual(CSV.parse(d.files[NAME]), state(true)); assert.deepEqual(e.box.state, state(true));
  });
  await test('queued saves finish in order and disconnect keeps the browser index', async () => {
    const d = directory(), e = env(); await e.repo.connect(d, NAME); const epoch = e.box.status.epoch;
    await Promise.all([e.repo.save(state(), epoch), e.repo.save(state(true), epoch)]);
    assert.deepEqual(CSV.parse(d.files[NAME]), state(true)); await e.repo.disconnect(); assert.equal(e.box.record, null);
    assert.deepEqual(e.box.state, state(true)); assert.equal(e.box.status.configured, false);
    await e.repo.save(state(), null); assert.deepEqual(e.box.state, state());
  });
  process.exit(process.exitCode || 0);
})();
