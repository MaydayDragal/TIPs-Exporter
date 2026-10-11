// Regression checks for the 1.20.4 QA fixes. Network, Chrome storage and native folders are simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

// The bulk scenario runs in a child process: the 1.20.3 name loop was synchronous, so an in-process timer could never fire.
if (process.argv[2] === '--bulk-scenario') { bulkScenario(); return; }

async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }
const CSV = require('../index-csv.js'), Client = require('../documents-client.js'), Folder = require('../index-folder.js'), Polling = require('../library-polling.js');
const L = require('../vendor/pdf-lib.min.js'), Scrubber = require('../pdf-scrubber.js')(L);

(async () => {
  await test('index CSV round-trips titles that start with an apostrophe and IDs with leading zeros', () => {
    const index = [{ tips: 'LI1', tipsId: 'a', version: 1, title: "'=cmd", mdate: '' }, { tips: 'LI2', tipsId: '007', version: 1, title: "'s Hertogenbosch", mdate: '' },
      { tips: 'LI3', tipsId: 9, version: 1, title: '=1+2', mdate: '' }];
    const parsed = CSV.parse(CSV.stringify(index, {}));
    assert.deepEqual(parsed.index.map(x => x.title), ["'=cmd", "'s Hertogenbosch", '=1+2']);
    assert.deepEqual(parsed.index.map(x => x.tipsId), ['a', '007', 9]);
    // A 1.20.3 file wrote "'=x" for a title "=x" and left "'s…" unprefixed: both still load as before.
    const legacy = CSV.stringify([{ tips: 'LI1', tipsId: 1, version: 1, title: 'x', mdate: '' }], {}).replace('"x"', '"\'s legacy"');
    assert.equal(CSV.parse(legacy).index[0].title, "'s legacy");
  });

  await test('portable names handle repeated shell-integrated extensions and stay stable', () => {
    for (const name of ['x.{a}.{b}', 'report.{CLSID}.lnk', 'a.url.url']) {
      const once = Client.portableName(name);
      assert(!/\.(lnk|local|url|scf|\{[^.]*\})$/i.test(once), name + ' -> ' + once);
      assert.equal(Client.portableName(once), once, 'idempotent for ' + name);
    }
  });

  await test('final earlier-version attachment errors are reported but do not fail the LI', () => {
    const item = { tips: 'LI42.10-P-078779', version: 5 };
    const note = `${item.tips}: attachment "photo.jpg" (v2) url HTTP 404${Client.PRIOR_NOTE}`;
    const r = Client.classifyErrors(item, [note, `${item.tips}: attachment "other.jpg" HTTP 500`]);
    assert.deepEqual(r.remaining, [`${item.tips}: attachment "other.jpg" HTTP 500`]);
  });

  await test('a re-saved index CSV with other line endings is not a conflict', async () => {
    const files = {}, NAME = Folder.DEFAULT_FILE || '_progress_log_all_documents.csv';
    const handle = { name: 'dir', async queryPermission() { return 'granted'; },
      async getFileHandle(n, o = {}) {
        if (!(n in files) && !o.create) throw Object.assign(Error('nf'), { name: 'NotFoundError' });
        return { async getFile() { return { size: files[n].length, text: async () => files[n] }; },
          async createWritable() { let t = ''; return { write: async v => { t += v; }, close: async () => { files[n] = t; }, abort: async () => {} }; } };
      } };
    let state = { index: [{ tips: 'LI00.00-P-000001', tipsId: 1, version: 1, title: 'A', mdate: '1' }], done: {} }, record = null;
    const repo = Folder.create({ readRecord: async () => record, writeRecord: async r => { record = r; }, readState: async () => structuredClone(state),
      writeState: async s => { state = structuredClone({ index: s.index, done: s.done }); }, writeStatus: async () => {} });
    assert((await repo.connect(handle)).ok);
    files[NAME] = files[NAME].replace(/\r\n/g, '\n');
    const base = CSV.stringify(state.index, state.done), next = { index: state.index, done: { 1: { b: 1, d: '2026-10-11T00:00:00Z', v: 1 } } };
    const r = await repo.save(next, record.epoch, base);
    assert.equal(r.ok, true, r.status && r.status.message);
    assert.equal(CSV.parse(files[NAME]).done[1].b, 1, 'browser progress was written to the folder');
  });

  await test('startup sync without folder access is handed back to the tab, which reports it', async () => {
    const listeners = []; const ev = () => ({ addListener: fn => listeners.push(fn) });
    const chrome = { runtime: { id: 'ext', onMessage: { addListener: fn => { chrome.onMessage = fn; } }, onStartup: ev(), onInstalled: ev() },
      storage: { local: { get: async () => ({ documentsFolder: { configured: true, auto: true, pollMinutes: 10 } }) }, onChanged: ev() },
      alarms: { get: async () => ({ periodInMinutes: 10 }), create: async () => {}, clear: async () => {}, onAlarm: ev() }, tabs: { query: async () => [] } };
    const db = { get: async () => ({ handle: { queryPermission: async () => 'prompt' } }) };
    Polling.create({ chrome, db }).start();
    const reply = await new Promise(resolve => chrome.onMessage({ type: 'library-poll-startup' }, { id: 'ext', url: 'https://xentry.mercedes-benz.com/tips-reader/x', tab: { id: 3 } }, resolve));
    assert.equal(reply.handled, false);
  });

  await test('PDF cleanup removes a user ID drawn one glyph at a time or split by kerning', async () => {
    const make = async content => { const d = await L.PDFDocument.create(), c = d.context, p = d.addPage([300, 200]);
      p.node.set(L.PDFName.of('Resources'), c.obj({ Font: { F1: c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })) } }));
      p.node.set(L.PDFName.of('Contents'), c.register(c.flateStream(content))); return d.save({ useObjectStreams: false }); };
    const text = async bytes => { const d = await L.PDFDocument.load(bytes); return d.context.enumerateIndirectObjects().filter(([, o]) => o instanceof L.PDFRawStream)
      .map(([, o]) => Buffer.from(L.decodePDFRawStream(o).decode()).toString('latin1')).join('\n'); };
    const rules = { enabled: true, strings: ['D7MASALL', 'D7XYZ123'], timestamp: true };
    const glyphs = await Scrubber.scrub(await make('BT /F1 8 Tf 10 10 Td ' + [...'D7XYZ123'].map(ch => `(${ch}) Tj 5 0 Td`).join(' ') + ' ET BT /F1 8 Tf 20 120 Td (Body) Tj ET'), rules);
    assert(!/\(Z\)/.test(await text(glyphs.bytes)) && /Body/.test(await text(glyphs.bytes)));
    const kerned = await Scrubber.scrub(await make('BT /F1 8 Tf 10 10 Td [(D7XY) -300 (Z123)] TJ ET BT /F1 8 Tf 20 120 Td (Body) Tj ET'), rules);
    assert(!/Z123/.test(await text(kerned.bytes)) && /Body/.test(await text(kerned.bytes)));
  });

  await test('bulk auto-continue stops on a batch that saves nothing, and long earlier-version names do not hang', () => {
    const r = spawnSync(process.execPath, [__filename, '--bulk-scenario'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.error, undefined, 'scenario finished (no hang): ' + (r.error && r.error.message));
    const out = JSON.parse((r.stdout.match(/^RESULT (.*)$/m) || [])[1] || 'null');
    assert(out, 'scenario output: ' + r.stdout + r.stderr);
    assert.equal(out.zips, 2, 'batch 1 (progress) and batch 2 (nothing saved), then stop');
    assert(out.priorName && /\(v1\)\.jpg$/.test(out.priorName) && out.priorName.length <= 60, 'earlier-version copy keeps its version tag: ' + out.priorName);
    assert.match(out.msg, /auto-continue stopped/);
  });
})();

function bulkScenario() {
  const { JSDOM } = require('jsdom');
  const tick = ms => new Promise(r => setTimeout(r, ms));
  const LONG = 'Wiring diagram for power steering control unit N68 with all connector pin assignments revision C.jpg';
  const T = [{ tips: 'LI42.10-P-078779', tipsId: 101, version: 1, title: 'A' }, { tips: 'LI46.10-P-070001', tipsId: 102, version: 1, title: 'B' },
    { tips: 'LI54.10-P-070002', tipsId: 103, version: 2, title: 'C' }];
  const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, saved = [];
  const st = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 20, delayMaxMs: 40, pageSize: 50, pageSizeSrc: 'detected', batchSize: 4, autoContinue: true, autoApprove: true, autoCheck: false },
    index: T.map(t => ({ ...t, mdate: '2026-10-01T00:00:00Z' })), done: {} };
  w.URL.createObjectURL = b => { saved.push({ blob: b }); return 'blob:x'; }; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { saved[saved.length - 1].name = this.download; };
  w.chrome = { storage: { local: { get: async k => ({ [k]: JSON.parse(JSON.stringify(st[k] ?? null)) ?? undefined }), set: async o => { Object.assign(st, JSON.parse(JSON.stringify(o))); } } },
    runtime: { getManifest: () => ({ version: 'qa' }), onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true;
  const att = (id, key) => ({ attId: id, filename: LONG, type: 'image', dataUrl: 'https://tips.test/a?readKey=' + key });
  w.fetch = async url => {
    const u = String(url), jpeg = () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]).buffer });
    if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1' }) };
    if (u.includes('/download/url?readKey=')) return { ok: true, status: 200, json: async () => ({ url: 'https://s3.test/' + u.split('readKey=')[1] }) };
    if (u.startsWith('https://s3.test/')) return jpeg();
    let m = u.match(/\/file\/topics\/(\d+)\/(\d+)\?/);
    if (m) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(1024).buffer };
    m = u.match(/\/topics\/(\d+)\/(\d+)\?/);
    if (m) {
      if (m[1] === '102') return { ok: false, status: 404, headers: { get: () => 'application/json' } };
      // C: v2 lists the file as attachment 2; v1 listed an older upload with the same long name.
      const attachments = m[1] === '103' ? [att(+m[2], 'K' + m[2])] : [];
      return { ok: true, status: 200, json: async () => ({ version: +m[2], attachments, references: [], history: { children: [] } }) };
    }
    return { ok: false, status: 404 };
  };
  require('./helpers/pdf-fixture').installPdfFixtures(w);
  w.eval(fs.readFileSync(path.join(ROOT, 'pagesize-probe.js'), 'utf8')); w.eval(fs.readFileSync(path.join(ROOT, 'index-csv.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'documents-client.js'), 'utf8')); w.eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
  (async () => {
    await tick(100); w.__toggle({ type: 'toggle' }, null, () => {}); await tick(50);
    const root = [...w.document.documentElement.children].find(e => e.shadowRoot && e.shadowRoot.querySelector('.dr')).shadowRoot;
    root.getElementById('tobulk').click(); await tick(20); root.getElementById('prep').click();
    await tick(8000);
    const first = saved[0] ? Buffer.from(await saved[0].blob.arrayBuffer()).toString('latin1') : '';
    const priorName = (first.match(/Attachments and Links\/([^\x00-\x1f/]*?\(v1\)\.jpg)/) || [])[1] || null;
    console.log('RESULT ' + JSON.stringify({ zips: saved.length, priorName, msg: root.textContent.replace(/\s+/g, ' ') }));
    process.exit(0);
  })();
}
