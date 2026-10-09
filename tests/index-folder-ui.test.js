const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const ROOT = path.join(__dirname, '..');
if (!fs.existsSync(path.join(ROOT, 'index-background.js')) || !fs.existsSync(path.join(ROOT, 'folder-settings.js'))) {
  console.log('FAIL folder Settings and automatic index integration are not implemented'); process.exit(1);
}
const CSV = require('../index-csv.js'), Repo = require('../index-folder.js');
const FILE = '_progress_log_all_documents.csv';
const ITEM = { tips: 'LI00.00-P-066047', tipsId: 101, version: 1, title: 'Odor', mdate: '2026-10-07' };
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 6000; while (!fn()) { if (Date.now() > end) throw Error('Timed out'); await tick(10); } }
function dir(text) {
  const d = { name: 'Shared index', permission: 'granted', files: text == null ? {} : { [FILE]: text }, requests: 0,
    async queryPermission() { return d.permission; }, async requestPermission() { d.requests++; d.permission = 'granted'; return d.permission; },
    async *values() { for (const name of Object.keys(d.files)) yield { name, kind: 'file' }; },
    async getFileHandle(name, o = {}) { if (!(name in d.files) && !o.create) throw Object.assign(Error('Missing'), { name: 'NotFoundError' });
      return { async getFile() { return { size: d.files[name].length, text: async () => d.files[name] }; }, async createWritable() { let value; return { async write(s) { value = s; }, async close() { d.files[name] = value; }, async abort() {} }; } }; }
  }; return d;
}
function worker() {
  const data = new Map(), state = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 0, delayMaxMs: 0,
    pageSize: 50, pageSizeSrc: 'detected', autoCheck: false, autoContinue: false, pdfScrub: { enabled: false } }, index: [], done: {} };
  const db = { get: async k => data.get(k), put: async (k, v) => data.set(k, v), del: async k => data.delete(k) };
  let listener, busy = false, opened = 0, locks = 0, releases = 0;
  const changes = [];
  const chrome = { runtime: { id: 'test-extension', getURL: p => 'chrome-extension://test-extension/' + p,
      onMessage: { addListener(fn) { listener = fn; } }, openOptionsPage: async () => { opened++; } },
    storage: { local: { get: async keys => structuredClone(typeof keys === 'string' ? { [keys]: state[keys] } : Object.fromEntries(keys.map(k => [k, state[k]]))),
      set: async o => { const c = {}; for (const k of Object.keys(o)) c[k] = { oldValue: state[k], newValue: o[k] }; Object.assign(state, structuredClone(o)); changes.forEach(fn => fn(c, 'local')); } }, onChanged: { addListener(fn) { changes.push(fn); } } },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async (id, m) => { if (m.type === 'index-folder-lock') { locks++; return { locked: !busy }; } releases++; return true; } }
  };
  const context = { chrome, TIPSFolderDB: db, TIPSIndexCsv: CSV, TIPSIndexFolder: Repo, console, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'index-background.js'), 'utf8'), context);
  const sender = kind => ({ id: chrome.runtime.id, url: kind === 'options' ? chrome.runtime.getURL('folder-settings.html') : kind === 'hostile' ? 'https://evil.test/' : 'https://xentry.mercedes-benz.com/tips-reader/search/topics', tab: { id: 1 } });
  async function send(action, payload = {}, kind = 'options') {
    return new Promise(resolve => { const keep = listener({ type: 'index-folder', action, ...payload }, sender(kind), resolve); if (!keep) resolve(undefined); });
  }
  return { state, data, db, chrome, send, setBusy: v => { busy = v; }, counters: () => ({ opened, locks, releases }) };
}
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
(async () => {
  await test('background connects only extension Settings and refuses source changes while a tab is busy', async () => {
    const e = worker(), d = dir(CSV.stringify([ITEM], {})); await e.db.put('candidate:one', { handle: d, filename: FILE });
    assert.equal((await e.send('connect', { token: 'one' }, 'reader')).ok, false);
    assert.equal((await e.send('status', {}, 'hostile')).ok, false);
    e.setBusy(true); assert.equal((await e.send('connect', { token: 'one' })).ok, false); assert.equal(e.state.index.length, 0);
    e.setBusy(false); await e.db.put('candidate:two', { handle: d, filename: FILE });
    assert((await e.send('connect', { token: 'two' })).ok); assert.equal(e.state.index[0].tips, ITEM.tips); assert(e.counters().releases > 0);
  });
  await test('folder Settings picks a directory, edits the filename, persists the handle and renews access', async () => {
    const e = worker(), d = dir(), dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'folder-settings.html'), 'utf8'), {
      url: 'https://extension.test/', runScripts: 'outside-only' });
    const w = dom.window; let picks = 0;
    w.TIPSFolderDB = e.db; w.TIPSIndexFolder = Repo; w.confirm = () => true;
    w.showDirectoryPicker = async options => { picks++; assert.equal(options.mode, 'readwrite'); return d; };
    w.chrome = { ...e.chrome, runtime: { ...e.chrome.runtime, sendMessage: msg => e.send(msg.action, msg) } };
    w.eval(fs.readFileSync(path.join(ROOT, 'folder-settings.js'), 'utf8'));
    const $ = id => w.document.getElementById(id); await until(() => !$('choose-folder').disabled);
    $('choose-folder').click(); await until(() => !$('use-folder').disabled);
    assert.equal(picks, 1); $('index-filename').value = 'my-index.csv'; $('use-folder').click();
    await until(() => e.state.indexFolder?.filename === 'my-index.csv'); assert('my-index.csv' in d.files);
    assert.equal((await e.db.get('connection')).handle, d);
    d.permission = 'prompt'; $('allow-access').click(); await until(() => d.requests === 1); await until(() => e.state.indexFolder.phase === 'saved');
    assert.equal(d.permission, 'granted'); await until(() => !$('choose-folder').disabled); dom.window.close();
  });
  await test('TIPS loads the selected file before using its index and only approval writes exported progress', async () => {
    const e = worker(), d = dir(CSV.stringify([ITEM], {}));
    await e.db.put('candidate:one', { handle: d, filename: FILE }); assert((await e.send('connect', { token: 'one' })).ok);
    // An external update is picked up during content initialization.
    const newer = { ...ITEM, title: 'Updated folder title' }; d.files[FILE] = CSV.stringify([newer], {});
    const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, saved = []; Object.assign(w, { TextEncoder, TextDecoder, Blob, indexedDB: new IDBFactory() });
    w.URL.createObjectURL = b => { saved.push(b); return 'blob:test'; }; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = () => {};
    w.chrome = { storage: e.chrome.storage, runtime: { ...e.chrome.runtime, sendMessage: msg => e.send(msg.action, msg, 'reader'), onMessage: { addListener(fn) { w.listener = fn; } } } };
    w.fetch = async url => String(url).includes('/file/topics/') ? { ok: true, arrayBuffer: async () => new ArrayBuffer(1024) } :
      { ok: true, json: async () => ({ version: 1, attachments: [], references: [], history: { children: [] } }) };
    require('./helpers/pdf-fixture').installPdfFixtures(w);
    w.eval(fs.readFileSync(path.join(ROOT, 'index-csv.js'), 'utf8')); w.eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
    await until(() => e.state.index[0].title === 'Updated folder title'); await tick(100); w.listener({ type: 'toggle' }, null, () => {});
    const root = () => [...w.document.documentElement.children].find(n => n.shadowRoot)?.shadowRoot, $ = id => root()?.getElementById(id);
    await until(() => $('tobulk')); $('tobulk').click(); $('prep').click(); await until(() => $('approve'));
    assert.equal(Object.keys(CSV.parse(d.files[FILE]).done).length, 0);
    $('approve').click(); await until(() => CSV.parse(d.files[FILE]).done[101]); assert.equal(saved.length, 1);
    assert.equal(CSV.parse(d.files[FILE]).done[101].v, 1);
  });
  await test('folder changes stay blocked throughout approval, including before the progress write starts', async () => {
    const e = worker(), d = dir(CSV.stringify([ITEM], {}));
    await e.db.put('candidate:one', { handle: d, filename: FILE }); assert((await e.send('connect', { token: 'one' })).ok);
    const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window; Object.assign(w, { TextEncoder, TextDecoder, Blob, indexedDB: new IDBFactory() });
    w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = () => {};
    w.chrome = { storage: e.chrome.storage, runtime: { ...e.chrome.runtime, sendMessage: msg => e.send(msg.action, msg, 'reader'), onMessage: { addListener(fn) { w.listener = fn; } } } };
    w.fetch = async url => String(url).includes('/file/topics/') ? { ok: true, arrayBuffer: async () => new ArrayBuffer(1024) } :
      { ok: true, json: async () => ({ version: 1, attachments: [], references: [], history: { children: [] } }) };
    require('./helpers/pdf-fixture').installPdfFixtures(w);
    w.eval(fs.readFileSync(path.join(ROOT, 'index-csv.js'), 'utf8')); w.eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
    await tick(100); w.listener({ type: 'toggle' }, null, () => {});
    const root = () => [...w.document.documentElement.children].find(n => n.shadowRoot)?.shadowRoot, $ = id => root()?.getElementById(id);
    await until(() => $('tobulk')); $('tobulk').click(); $('prep').click(); await until(() => $('approve'));
    const set = e.chrome.storage.local.set; let release;
    e.chrome.storage.local.set = async value => {
      if ('retry' in value && !('index' in value)) await new Promise(resolve => { release = resolve; });
      return set(value);
    };
    $('approve').click(); await until(() => release);
    // Drain the pending-ZIP deletion. Its persistence guard must not be the only approval guard.
    const db = await new Promise((resolve, reject) => { const q = w.indexedDB.open('tips-exporter', 1); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('kv', 'readonly'); tx.objectStore('kv').get('pending'); tx.oncomplete = resolve; tx.onerror = reject; });
    let during; w.listener({ type: 'index-folder-lock', token: 'during' }, null, r => { during = r; });
    release(); await until(() => CSV.parse(d.files[FILE]).done[101]); await until(() => e.state.history?.length === 1);
    const wasBlocked = during?.locked === false;
    if (!wasBlocked) await new Promise(resolve => w.listener({ type: 'index-folder-unlock', token: 'during' }, null, resolve));
    let after; w.listener({ type: 'index-folder-lock', token: 'after' }, null, r => { after = r; });
    db.close(); dom.window.close();
    assert(wasBlocked, 'Changing the index folder must be refused until approval has fully committed');
    assert.equal(after.locked, true, 'The approval guard must be released after committing');
  });
  await test('folder changes stay blocked while a manual progress CSV is being read', async () => {
    const e = worker(), d = dir(CSV.stringify([ITEM], {}));
    await e.db.put('candidate:one', { handle: d, filename: FILE }); assert((await e.send('connect', { token: 'one' })).ok);
    const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window; Object.assign(w, { TextEncoder, TextDecoder, Blob, indexedDB: new IDBFactory() });
    w.chrome = { storage: e.chrome.storage, runtime: { ...e.chrome.runtime, sendMessage: msg => e.send(msg.action, msg, 'reader'), onMessage: { addListener(fn) { w.listener = fn; } } } };
    require('./helpers/pdf-fixture').installPdfFixtures(w);
    w.eval(fs.readFileSync(path.join(ROOT, 'index-csv.js'), 'utf8')); w.eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
    await tick(100); w.listener({ type: 'toggle' }, null, () => {});
    const root = () => [...w.document.documentElement.children].find(n => n.shadowRoot)?.shadowRoot, $ = id => root()?.getElementById(id);
    await until(() => $('tobulk')); $('tobulk').click();
    let release;
    Object.defineProperty($('file'), 'files', { value: [{ text: () => new Promise(resolve => { release = resolve; }) }] });
    $('file').dispatchEvent(new w.Event('change')); await until(() => release);
    let during; w.listener({ type: 'index-folder-lock', token: 'during' }, null, r => { during = r; });
    release(CSV.stringify([{ ...ITEM, title: 'Imported title' }], {}));
    await until(() => CSV.parse(d.files[FILE]).index[0].title === 'Imported title');
    if (during?.locked) await new Promise(resolve => w.listener({ type: 'index-folder-unlock', token: 'during' }, null, resolve));
    let after; w.listener({ type: 'index-folder-lock', token: 'after' }, null, r => { after = r; });
    dom.window.close();
    assert.equal(during.locked, false, 'Changing the folder must be refused until the selected CSV has been read and saved');
    assert.equal(after.locked, true, 'The import guard must be released after saving');
  });
  process.exit(process.exitCode || 0);
})();
