const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const { directory } = require('./memory-fs');
const { makePdf, assertSavedPdf } = require('./pdf-fixture');
globalThis.crypto ||= webcrypto;
const ROOT = path.join(__dirname, '../..');
const LI = 'LI00.00-P-066047', TOPIC = `Batch 001/${LI} - Old title (Requested)`;
const ITEM = { tips: LI, tipsId: 101, version: 5, title: 'New title', mdate: '2026-10-08' };
const pdf = v => `%PDF-1.7\nversion ${v}\n%%EOF`;
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label = 'condition') { const end = Date.now() + 8000; while (!fn()) { if (Date.now() > end) throw Error('Timed out: ' + label); await tick(10); } }
function worker() {
  const data = new Map(), listeners = [], tabs = new Map(), changes = [], messages = [];
  const state = { index: [structuredClone(ITEM)], done: { 101: { b: 1, v: 5 } }, settings: { outlet: 'o1', user: 'u1', ver: '1.22.0',
    delayMs: 0, delayMaxMs: 0, pageSize: 50, pageSizeSrc: 'detected', autoCheck: false, autoContinue: false, pdfScrub: { enabled: false } } };
  const db = { get: async k => data.get(k), put: async (k,v) => data.set(k,v), del: async k => data.delete(k) };
  const chrome = { runtime: { id: 'test-extension', getURL: p => 'chrome-extension://test-extension/' + p,
    getManifest: () => ({ version: '1.16.0' }), onMessage: { addListener: fn => listeners.push(fn) }, openOptionsPage: async () => {} },
    storage: { local: { get: async keys => structuredClone(typeof keys === 'string' ? { [keys]: state[keys] } : Object.fromEntries(keys.map(k => [k, state[k]]))),
      set: async values => { const c = {}; for (const k of Object.keys(values)) c[k] = { oldValue: state[k], newValue: values[k] }; Object.assign(state, structuredClone(values)); changes.forEach(fn => fn(c, 'local')); } }, onChanged: { addListener: fn => changes.push(fn), removeListener: fn => { const i = changes.indexOf(fn); if (i >= 0) changes.splice(i, 1); } } },
    tabs: { query: async () => [...tabs.keys()].map(id => ({ id })), sendMessage: async (id, m) => { if (!tabs.has(id)) throw Error('No receiver'); return tabs.get(id)(m); } }
  };
  const context = { chrome, TIPSFolderDB: db, TIPSIndexFolder: require('../../index-folder'), TIPSIndexCsv: require('../../index-csv'),
    TIPSDocumentsFolder: require('../../documents-folder'), console, crypto: webcrypto, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'index-background.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'documents-background.js'), 'utf8'), context);
  async function send(action, payload = {}, kind = 'reader', tabId = 1) {
    const m = JSON.parse(JSON.stringify({ type: 'documents-folder', action, ...payload })); messages.push(m);
    const sender = { id: chrome.runtime.id, url: kind === 'options' ? chrome.runtime.getURL('folder-settings.html') : kind === 'hostile' ? 'https://evil.test/' : 'https://xentry.mercedes-benz.com/tips-reader/search/topics', tab: { id: tabId } };
    return new Promise(resolve => { let pending = false; for (const fn of listeners) pending = fn(m, sender, r => resolve(JSON.parse(JSON.stringify(r)))) || pending; if (!pending) resolve(undefined); });
  }
  return { state, data, db, chrome, send, tabs, messages };
}
async function connected(options = {}) {
  const e = worker(), d = directory();
  for (let v = 1; v <= 4; v++) await d.put(`${TOPIC}/${LI}_v${v}.pdf`, pdf(v));
  await d.put(`${TOPIC}/Attachments and Links/photo.jpg`, 'old photo');
  await e.db.put('documents-candidate:first', { handle: d });
  const r = await e.send('connect', { token: 'first', options: { auto: false, ...options } }, 'options');
  if (!r.ok) throw Error(r.error); return { ...e, d };
}
async function content(e, fetchHook, { startAuto = false, section = 'advanced' } = {}) {
  // Most document tests explicitly initiate updates. Enable on-load automation only
  // in tests that exercise it; restore the user's auto choice once this tab is loaded.
  const configuredAuto = e.state.documentsFolder?.auto;
  if (!startAuto && configuredAuto) e.state.documentsFolder.auto = false;
  const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, downloads = [], requests = [], active = { version: 5, attachment: 'new photo', mdate: ITEM.mdate };
  const observers = [], Observer = w.MutationObserver;
  w.MutationObserver = class extends Observer { constructor(fn) { super(fn); observers.push(this); } };
  Object.assign(w, { TextEncoder, TextDecoder, Blob, Response, CompressionStream, indexedDB: new IDBFactory() });
  Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle });
  w.URL.createObjectURL = b => { downloads.push(b); return 'blob:test'; }; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = () => {};
  let listener; const storageListeners = [];
  e.tabs.set(1, m => new Promise(resolve => { const keep = listener?.(m, {id:e.chrome.runtime.id}, resolve); if (!keep && !listener) resolve({ locked: true }); }));
  w.chrome = { storage: { ...e.chrome.storage, onChanged: { addListener: fn => { storageListeners.push(fn); e.chrome.storage.onChanged.addListener(fn); } } }, runtime: { ...e.chrome.runtime, sendMessage: m => e.send(m.action, m), onMessage: { addListener: fn => { listener = fn; } } } };
  const json = value => ({ ok: true, status: 200, json: async () => value });
  const binary = value => ({ ok: true, status: 200, arrayBuffer: async () => (typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)).buffer });
  w.fetch = async (url, options) => {
    const u = String(url); requests.push(u);
    const custom = await fetchHook?.(u, options, { active, binary, json }); if (custom) return custom;
    if (options?.method === 'POST') return json({ hits: [{ ...ITEM, version: active.version, modificationDate: active.mdate }], totalHits: 1 });
    if (u.includes('/file/topics/')) return binary(await makePdf('version ' + +u.match(/\/file\/topics\/101\/(\d+)/)[1]));
    if (u.includes('/topics/101/')) return json({ version: active.version, attachments: [{ filename: 'photo.jpg', dataUrl: 'https://attachments.test/?readKey=one' }], references: [], history: { children: [] } });
    if (u.includes('/read/download/url')) return json({ url: 'https://files.test/photo' });
    if (u === 'https://files.test/photo') return binary(active.attachment);
    throw Error('Unexpected fetch ' + u);
  };
  for (const f of ['vendor/pdf-lib.min.js', 'pdf-scrubber.js', 'index-csv.js', 'documents-client.js', 'content.js']) w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  await until(() => listener); await tick(100); listener({ type: 'toggle' }, null, () => {});
  const root = () => [...w.document.documentElement.children].find(n => n.shadowRoot)?.shadowRoot;
  const $ = id => root()?.getElementById(id); await until(() => $('tobulk'));
  if (!startAuto && configuredAuto) await e.chrome.storage.local.set({documentsFolder:{...e.state.documentsFolder,auto:true}});
  if (section === 'advanced') $('tobulk').click();
  return { w, dom, $, root, active, requests, downloads, close: () => { e.tabs.delete(1); observers.forEach(o => o.disconnect()); storageListeners.forEach(fn => e.chrome.storage.onChanged.removeListener(fn)); dom.window.close(); } };
}
module.exports = { ROOT, LI, TOPIC, ITEM, pdf, tick, until, worker, connected, content, directory, JSDOM, makePdf, assertSavedPdf };
