// Synthetic case data only. These tests exercise the real observer and viewer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const path = require('node:path');
const src = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 30));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let C;
function env() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/cases/123', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(w, { Response, Request, Headers, TextDecoder, TextEncoder, ReadableStream });
  // jsdom does not implement same-window source/origin for postMessage.
  w.postMessage = data => queueMicrotask(() => w.dispatchEvent(new w.MessageEvent('message', { data, source: w, origin: w.location.origin })));
  w.eval(src('case-inspector-core.js'));
  return { dom, w };
}
function record(n, body = { rating: 0, status: 'open' }) {
  return { id: n, route: '/tips-reader/search/cases/123', url: 'https://xentry.mercedes-benz.com/tips/case-service/api/v1/cases/123', method: 'GET', status: 200, started: '2026-11-16T12:00:00.000Z', duration: 12, request: { state: 'empty' }, response: { state: 'json', value: body } };
}
test('core is available', () => {
  assert(fs.existsSync(path.join(__dirname, '..', 'case-inspector-core.js')), 'case inspector core not implemented');
  const e = env(); C = e.w.TipsCaseCore; assert(C); e.dom.window.close();
});
test('nested credentials and signed URL parameters are redacted without losing case fields', () => {
  const value = C.sanitize({ rating: 0, accessToken: 'SECRET', nested: { Authorization: 'Bearer SECRET', password: 'SECRET', cookie: 'SECRET' }, link: 'https://xentry.mercedes-benz.com/a?readKey=SECRET&caseId=123#SECRET' });
  const s = JSON.stringify(value); assert(!s.includes('SECRET')); assert(s.includes('123')); assert.equal(value.rating, 0);
});
test('non-JSON and oversized bodies are explicitly omitted; deep JSON is bounded', () => {
  assert.equal(C.body('password=SECRET').state, 'omitted');
  assert.equal(C.body('x'.repeat(300000)).state, 'omitted');
  assert.equal(C.body('{"rating":null}').value.rating, null);
  let deep = {}; for (let i = 0; i < 100; i++) deep = { child: deep };
  assert(JSON.stringify(C.sanitize(deep)).length < 3000);
});
test('relative signed links and escaped oversized JSON objects are not retained', () => {
  assert(!JSON.stringify(C.body({ downloadUrl: '/tips/file?access_token=SECRET&signature=SECRET&caseId=123' })).includes('SECRET'));
});
test('escaped oversized JSON objects are omitted', () => {
  const oversized = {}; for (let i = 0; i < 4000; i++) oversized['field' + i] = '\u0001'.repeat(12);
  assert.equal(C.body(oversized).state, 'omitted');
});
test('pause cancels active observer stream branches and excessive concurrent reads are omitted', async () => {
  const e = env(), w = e.w; let cancelled = 0, clones = 0; const records = [];
  // External transport double provides a stalled stream and exposes cancellation, not application logic.
  w.fetch = async () => ({status: 200, headers: new Headers({'content-type':'application/json'}), clone() {
    clones++; let end;
    return {body: {getReader() {return {read() {return new Promise(r => {end=r;});}, cancel() {cancelled++; end?.({done:true}); return Promise.resolve();}, releaseLock() {}};}}};
  }});
  w.addEventListener('message', ev => {if(ev.data.kind==='record') records.push(ev.data.record);});
  w.eval(src('case-inspector-probe.js'));
  for(let i=0;i<40;i++) await w.fetch('/tips/case-service/api/v1/cases/123');
  await tick(); assert(clones <= 16, 'observer must bound concurrent reads');
  assert(records.some(r => r.response.state === 'omitted'), 'busy observer reports omission');
  w.postMessage({type:'tipsx-case-command',action:'pause'});await tick();assert.equal(cancelled, clones);
  e.dom.window.close();
});
test('timed-out body reads report omission rather than treating cancellation as a complete body', async () => {
  const e=env(), w=e.w, records=[]; const timer=w.setTimeout.bind(w);
  w.setTimeout=(fn,ms)=>timer(fn,ms===10000?1:ms);
  w.fetch=async()=>({status:200,headers:new Headers({'content-type':'application/json'}),clone(){let end;return {body:{getReader(){return {read(){return new Promise(r=>{end=r;});},cancel(){end({done:true});return Promise.resolve();},releaseLock(){}};}}};}});
  w.addEventListener('message',ev=>{if(ev.data.kind==='record')records.push(ev.data.record);});w.eval(src('case-inspector-probe.js'));
  await w.fetch('/tips/case-service/api/v1/cases/123');await tick();assert.equal(records[0].response.state,'omitted');assert(records[0].response.reason.includes('timed out'));e.dom.window.close();
});
test('capture excludes unrelated hosts, resources and authentication endpoints', () => {
  const route = '/tips-reader/search/cases/123';
  assert(C.eligible('/tips/case-service/api/v1/cases/123', '/tips-reader/search/topics'));
  assert(C.eligible('/tips/workflow-service/api/v1/history', route));
  assert(!C.eligible('https://other.example/tips/case-service/api/v1/cases/123', route));
  assert(!C.eligible('/tips/common-service/api/v1/xentry/currentuser', route));
  assert(!C.eligible('/tips/topic-service/api/v1/topics/search', '/tips-reader/search/topics'));
  assert(!C.eligible('/tips-reader/main.js', route));
});
test('bounded store evicts old records, rejects oversized records and resets on clear', () => {
  const s = C.createStore(); for (let i = 1; i <= 130; i++) s.add(record(i));
  assert.equal(s.list().length, 100); assert.equal(s.list()[0].id, 31); assert.equal(s.dropped, 30);
  s.add(record(131, { big: 'x'.repeat(3000000) })); assert(s.list().length <= 100);
  assert(JSON.stringify(s.list()).length < 2100000);
  s.clear(); assert.equal(s.list().length, 0); assert.equal(s.dropped, 0);
});
test('summary distinguishes missing ratings from zero and preserves candidate source paths', () => {
  const s = C.summarize([record(1, { rating: 0, count: 4, messages: [{ text: 'Workshop reply', internal: true }], status: 'open' })]);
  assert(s.ratings.some(x => x.value === 0));
  assert(s.communication.some(x => x.path.includes('messages')));
  assert(s.fields.some(x => x.path.endsWith('.status') && x.value === 'open'));
  assert.equal(C.summarize([record(2, { status: 'closed' })]).ratings.length, 0);
});
test('fetch preserves response and original arguments; buffers early data and request context', async () => {
  const e = env(), w = e.w, messages = []; let args, release;
  w.addEventListener('message', ev => { if (ev.data.type === 'tipsx-case-data') messages.push(ev.data); });
  const response = new Response('{"rating":4,"accessToken":"SECRET"}', { headers: { 'content-type': 'application/json' } });
  w.fetch = (...a) => { args = a; return new Promise(r => { release = () => r(response); }); };
  w.eval(src('pagesize-probe.js')); w.eval(src('case-inspector-probe.js'));
  const url = '/tips/case-service/api/v1/cases/123'; const options = { method: 'POST', body: '{"text":"hello","password":"SECRET"}' };
  const p = w.fetch(url, options); assert.equal(args[0], url); assert.equal(args[1], options);
  w.history.pushState({}, '', '/tips-reader/search/cases/456'); release(); assert.equal(await p, response);
  assert.equal(await response.text(), '{"rating":4,"accessToken":"SECRET"}'); await tick();
  w.postMessage({ type: 'tipsx-case-command', action: 'snapshot' }); await tick();
  const snapshot = messages.filter(x => x.kind === 'snapshot').at(-1);
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].route, '/tips-reader/search/cases/123');
  assert(!JSON.stringify(snapshot).includes('SECRET')); assert.equal(snapshot.records[0].response.value.rating, 4);
  e.dom.window.close();
});
test('fetch Request bodies, HTTP errors, rejection and binary responses remain observable and unchanged', async () => {
  const e = env(), w = e.w, records = [];
  w.addEventListener('message', ev => { if (ev.data.type === 'tipsx-case-data' && ev.data.kind === 'record') records.push(ev.data.record); });
  let response = new Response('{"message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  let failure;
  w.fetch = () => failure ? Promise.reject(failure) : Promise.resolve(response);
  w.eval(src('case-inspector-probe.js'));
  await w.fetch(new Request('https://xentry.mercedes-benz.com/tips/case-service/api/v1/cases/123', { method: 'POST', body: '{"caseId":"123"}' })); await tick();
  assert.equal(records[0].request.value.caseId, '123'); assert.equal(records[0].status, 404);
  failure = new Error('network failure'); await assert.rejects(w.fetch('/tips/case-service/api/v1/cases/123'), err => err === failure); await tick();
  assert.equal(records[1].status, 0); assert.equal(records[1].response.state, 'error');
  failure = null; response = new Response('BINARY', { headers: { 'content-type': 'application/pdf' } });
  await w.fetch('/tips/case-service/api/v1/cases/123'); await tick(); assert.equal(records[2].response.state, 'omitted');
  e.dom.window.close();
});
test('clear and pause invalidate pending response reads; resume accepts new responses', async () => {
  const e = env(), w = e.w, records = []; let release;
  w.fetch = () => new Promise(r => { release = () => r(new Response('{"rating":1}', { headers: { 'content-type': 'application/json' } })); });
  w.addEventListener('message', ev => { if (ev.data.kind === 'record') records.push(ev.data.record); });
  w.eval(src('case-inspector-probe.js'));
  let p = w.fetch('/tips/case-service/api/v1/cases/123'); w.postMessage({ type: 'tipsx-case-command', action: 'clear' }); await tick(); release(); await p; await tick(); assert.equal(records.length, 0);
  p = w.fetch('/tips/case-service/api/v1/cases/123'); w.postMessage({ type: 'tipsx-case-command', action: 'pause' }); await tick(); release(); await p; await tick(); assert.equal(records.length, 0);
  w.postMessage({ type: 'tipsx-case-command', action: 'resume' }); await tick();
  p = w.fetch('/tips/case-service/api/v1/cases/123'); release(); await p; await tick(); assert.equal(records.length, 1);
  e.dom.window.close();
});
test('XHR captures JSON and errors without changing native return values or accumulating reuse listeners', async () => {
  const e = env(), w = e.w, records = [];
  class XHR extends w.EventTarget {
    open(method, url) { this.method = method; this.url = url; return 'open-result'; }
    send(body) { this.sent = body; return 'send-result'; }
    getResponseHeader() { return 'application/json'; }
    finish(status, value) { this.status = status; this.responseType = 'json'; this.response = value; this.dispatchEvent(new w.Event('loadend')); }
  }
  w.XMLHttpRequest = XHR; w.fetch = () => Promise.resolve(new Response('{}'));
  w.addEventListener('message', ev => { if (ev.data.kind === 'record') records.push(ev.data.record); });
  w.eval(src('case-inspector-probe.js'));
  const x = new w.XMLHttpRequest(); assert.equal(x.open('GET', '/tips/case-service/api/v1/cases/123'), 'open-result'); assert.equal(x.send(null), 'send-result'); x.finish(200, { rating: 2 }); await tick();
  x.open('GET', '/tips/case-service/api/v1/cases/123'); x.send(null); x.finish(0, null); await tick();
  assert.equal(records.length, 2); assert.equal(records[0].response.value.rating, 2); assert.equal(records[1].status, 0);
  e.dom.window.close();
});
test('viewer shows missing/zero ratings, safely displays messages, filters contexts and exports JSON', async () => {
  const e = env(), w = e.w; let blob, copied;
  w.URL.createObjectURL = b => { blob = b; return 'blob:test'; }; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { assert(this.download.endsWith('.json')); };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async t => { copied = t; } } });
  w.eval(src('case-inspector.js')); const I = w.TipsCaseInspector;
  const host = w.document.createElement('div'); w.document.body.append(host); const root = host.attachShadow({ mode: 'open' });
  const render = () => { root.innerHTML = I.html(); I.bind(root, render); }; I.onChange(render); render();
  assert(root.textContent.includes('Unavailable'));
  w.postMessage({ type: 'tipsx-case-data', kind: 'record', record: record(1, { rating: 0, messages: [{ text: '<img src=x onerror=alert(1)>', internal: true }] }) }); await tick();
  assert(root.textContent.includes('rating')); assert(root.textContent.includes('0'));
  root.getElementById('case_communication').click(); assert(root.textContent.includes('<img')); assert.equal(root.querySelector('img'), null);
  root.getElementById('case_raw').click(); assert(root.textContent.includes('200'));
  const search = root.getElementById('case_search'); search.value = 'not-present'; search.dispatchEvent(new w.Event('input')); assert(!root.querySelector('.case-record'));
  root.getElementById('case_search').value = ''; root.getElementById('case_search').dispatchEvent(new w.Event('input'));
  root.getElementById('case_copy').click(); await tick(); assert.equal(JSON.parse(copied).records.length, 1);
  root.getElementById('case_export').click(); assert(blob);
  const b = record(2, { rating: 5 }); b.route = '/tips-reader/search/cases/456'; w.postMessage({ type: 'tipsx-case-data', kind: 'record', record: b }); await tick();
  root.getElementById('case_copy').click(); await tick(); assert.equal(JSON.parse(copied).records.length, 1);
  w.history.pushState({}, '', '/tips-reader/search/cases/456'); render(); root.getElementById('case_copy').click(); await tick(); assert.equal(JSON.parse(copied).records[0].response.value.rating, 5);
  root.getElementById('case_clear').click(); await tick(); assert(root.textContent.includes('No captured'));
  e.dom.window.close();
});
test('manifest scripts integrate Cases into the real drawer without breaking Library or Advanced', async () => {
  const e = env(), w = e.w;
  const state = {};
  w.chrome = {storage:{local:{get:async k=>({[k]:state[k]}),set:async o=>Object.assign(state,o)}},runtime:{onMessage:{addListener(fn){w.toggleExporter=fn;}},getManifest:()=>({version:'1.22.0'})}};
  w.fetch = async url => new Response(JSON.stringify(String(url).includes('currentuser') ? {userId:'TEST',currentOutlet:'test'} : {caseId:'123',rating:3,messages:[{text:'Synthetic message'}]}), {headers:{'content-type':'application/json'}});
  Object.assign(w, { Blob, CompressionStream });
  const manifest = JSON.parse(src('manifest.json'));
  for(const script of manifest.content_scripts.flatMap(s=>s.js)) w.eval(src(script));
  await tick(); w.toggleExporter({type:'toggle'},null,()=>{});await tick();
  const root=[...w.document.documentElement.children].find(el=>el.shadowRoot)?.shadowRoot;assert(root);
  root.getElementById('tocases').click();assert.equal(root.getElementById('cases_panel').hidden,false);
  await w.fetch('/tips/case-service/api/v1/cases/123');await tick();assert(root.getElementById('cases_panel').textContent.includes('$.rating'));
  const search=root.getElementById('case_search');search.focus();search.value='rating';search.dispatchEvent(new w.Event('input'));assert.equal(root.activeElement.id,'case_search');
  root.getElementById('tolibrary').click();assert.equal(root.getElementById('library_panel').hidden,false);assert.equal(root.getElementById('cases_panel').hidden,true);
  root.getElementById('toadvanced').click();assert.equal(root.getElementById('advanced_panel').hidden,false);assert(root.getElementById('look'));
  e.dom.window.close();
});
(async () => {
  for (const [name, fn] of tests) { try { await fn(); console.log('PASS ' + name); } catch (err) { console.error('FAIL ' + name + ': ' + err.stack); process.exitCode = 1; if (!C) break; } }
})();
