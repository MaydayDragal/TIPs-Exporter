// Simulated TIPS Reader tab: fake search/topic/PDF endpoints, probe + content script loaded into jsdom.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');

const N = 3469;
const topics = Array.from({ length: N }, (_, i) => ({ tips: `LI${String(10 + i % 80).padStart(2, '0')}.10-P-${100000 + i}`, tipsId: 'id' + i, version: 1, title: 'T' + i, modificationDate: 1e12 + i }));
const log = [];
let failAfterHits = Infinity;

async function fakeFetch(url, init = {}) {
  const u = String(url), t = Date.now();
  if (u.includes('/topics/search')) {
    const b = JSON.parse(init.body); const { pageNumber: p, pageSize: n } = b.pagination;
    log.push({ t, kind: 'search', p, n, order: b.sortorder.order });
    const sorted = b.sortorder.order === 'asc' ? topics : [...topics].reverse();
    const start = (p - 1) * n;
    return { ok: true, status: 200, json: async () => ({ totalHits: N, hits: start >= failAfterHits ? [] : sorted.slice(start, start + n) }) };
  }
  if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: 'o1' }) };
  if (u.includes('/file/topics/')) { log.push({ t, kind: 'pdf' }); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; }
  if (/\/topics\/id\d+\/\d+/.test(u)) { log.push({ t, kind: 'doc' }); return { ok: true, status: 200, json: async () => ({ version: 1, attachments: [], references: [], history: { children: [] } }) }; }
  return { ok: false, status: 404 };
}

function makeEnv(settings, extra = {}) {
  const dom = new JSDOM('<!doctype html><body>TIPS Reader v1.22.0 - 2026</body>', { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const st = { settings, ...extra };
  w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
  w.chrome = { storage: { local: { get: async k => ({ [k]: st[k] }), set: async o => Object.assign(st, o) } }, runtime: { onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => { log.push('confirm'); return w.__confirmAnswer ?? true; };
  w.fetch = fakeFetch;
  const pm = w.postMessage.bind(w);
  w.postMessage = (d, o) => { if (d && d.__tipsx) setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { data: d, source: w })), 0); else pm(d, o); };
  w.eval(probe);
  w.eval(content);
  const env = { w, st, root: () => [...w.document.documentElement.children].find(e => e.shadowRoot).shadowRoot };
  env.open = async () => {
    await tick(100);
    w.__toggle({ type: 'toggle' }, null, () => { });
    await tick(20); { const tb = env.root().getElementById('tobulk'); if (tb) tb.click(); }
    await tick(50);
    if (!env.root().getElementById('build')) throw new Error('panel did not open');
  };
  return env;
}
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 120000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(20); } }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const S0 = { outlet: 'o1', user: 'u1', ver: '1.22.0' };

(async () => {
  // 1. migration + undetected page size
  const env = makeEnv({ ...S0, delayMs: 250 });
  await env.open();
  ok(env.st.settings.delayMs === 2000 && env.st.settings.delayMaxMs === 5000, `old 250 ms delay migrated to 2000–5000 ms (got ${env.st.settings.delayMs}–${env.st.settings.delayMaxMs})`);
  ok(env.st.settings.pageSizeSrc === 'default', 'page size starts undetected');
  env.w.__confirmAnswer = false; log.length = 0;
  env.root().getElementById('build').click(); await tick(150);
  ok(log.includes('confirm') && !log.some(e => e.kind === 'search'), 'undetected: asks first; Cancel sends no search');

  // 2. probe sees the Reader's own searches (fetch and XHR)
  await env.w.fetch('/tips/topic-service/api/v1/topics/search?x', { method: 'POST', body: JSON.stringify({ pagination: { pageNumber: 1, pageSize: 25 }, sortorder: { order: 'desc' } }) });
  await tick(100);
  ok(env.st.settings.pageSize === 25 && env.st.settings.pageSizeSrc === 'detected', `fetch search detected (got ${env.st.settings.pageSize}/${env.st.settings.pageSizeSrc})`);
  const x = new env.w.XMLHttpRequest(); x.open('POST', '/tips/topic-service/api/v1/topics/search'); try { x.send(JSON.stringify({ pagination: { pageSize: 20 } })); } catch (e) { } try { x.abort(); } catch (e) { }
  await tick(100);
  ok(env.st.settings.pageSize === 20, `XHR search detected (got ${env.st.settings.pageSize})`);

  // 3. build index: one pass, oldest-first, Reader page size, 300 ms spacing
  log.length = 0;
  env.root().getElementById('build').click();
  await waitFor(() => /Index built/.test(env.root().textContent));
  const sr = log.filter(e => e.kind === 'search');
  ok(!log.includes('confirm'), 'no prompt once detected');
  ok(sr.every(s => s.n === 20 && s.order === 'asc'), 'all index requests: pageSize 20, oldest-first');
  ok(sr.length === Math.ceil(N / 20), `single pass: ${sr.length} requests (expected ${Math.ceil(N / 20)}; old code sent 16 at 500/page)`);
  ok(env.st.index.length === N, `index has all ${N} topics (got ${env.st.index.length})`);
  const gaps = sr.slice(1).map((s, i) => s.t - sr[i].t);
  ok(Math.min(...gaps) >= 290, `≥300 ms between pages (min ${Math.min(...gaps)} ms)`);
  console.log('     msg:', env.root().querySelector('.note').textContent);

  // 4. short result set warns
  failAfterHits = 1000;
  env.root().getElementById('refresh').click();
  await waitFor(() => /appended/.test(env.root().textContent));
  ok(/only 2000 topics could be read/.test(env.root().textContent) && log.some(e => e.kind === 'search' && e.order === 'desc'), 'capped search: fills in from the newest end, then warns about what is still missing');
  console.log('     msg:', env.root().querySelector('.note').textContent);
  failAfterHits = Infinity;

  // 5. batch: random delay between docs, none before first
  const idx = topics.slice(0, 6).map(h => ({ tips: h.tips, tipsId: h.tipsId, version: 1, title: h.title, mdate: 0 }));
  const e2 = makeEnv({ ...S0, delayMs: 300, delayMaxMs: 900, batchSize: 6, pageSize: 20, pageSizeSrc: 'detected', autoContinue: false }, { index: idx });
  await e2.open();
  log.length = 0; const t0 = Date.now();
  e2.root().getElementById('prep').click();
  await tick(150);
  ok(/waiting \d s before next document/.test(e2.root().textContent), 'progress shows the countdown while waiting');
  await waitFor(() => /ready for review/.test(e2.root().textContent));
  const docs = log.filter(e => e.kind === 'doc');
  const dg = docs.slice(1).map((d, i) => d.t - docs[i].t);
  console.log('     gaps between docs (ms):', dg.join(', '));
  ok(docs.length === 6, '6 documents exported');
  ok(dg.every(g => g >= 290 && g <= 1000), 'every gap inside 300–900 ms (+ timer slack)');
  ok(Math.max(...dg) - Math.min(...dg) > 60, 'gaps vary');
  ok(docs[0].t - t0 < 200, `no wait before first doc (${docs[0].t - t0} ms)`);
  ok(Date.now() - docs[5].t < 300, 'no wait after last doc');

  // 6. cancel during a long wait stops promptly
  e2.root().getElementById('discard').click(); await tick(50);
  e2.st.settings; // settings live in S; change via UI
  e2.root().getElementById('gear').click(); await tick(20);
  e2.root().getElementById('s_delay').value = '8000'; e2.root().getElementById('s_delay2').value = '6000';
  e2.root().getElementById('s_save').click(); await tick(50);
  ok(e2.st.settings.delayMs === 6000 && e2.st.settings.delayMaxMs === 8000, `min/max entered backwards are swapped (got ${e2.st.settings.delayMs}–${e2.st.settings.delayMaxMs})`);
  ok(e2.st.settings.pageSizeSrc === 'detected', 'saving settings without touching page size keeps it "detected"');
  e2.root().getElementById('gear').click(); await tick(20);
  log.length = 0;
  e2.root().getElementById('prep').click();
  await waitFor(() => log.filter(e => e.kind === 'doc').length === 1);
  await tick(300);
  const tc = Date.now();
  e2.root().getElementById('cancel').click();
  await waitFor(() => /cancelled/.test(e2.root().textContent), 3000);
  ok(Date.now() - tc < 600, `cancel during a 6–8 s wait takes effect in ${Date.now() - tc} ms`);
  ok(log.filter(e => e.kind === 'doc').length === 1, 'no further documents after cancel');

  // 7. manual page size sticks; probe doesn't override it
  e2.root().getElementById('gear').click(); await tick(20);
  e2.root().getElementById('s_ps').value = '40'; e2.root().getElementById('s_save').click(); await tick(50);
  await e2.w.fetch('/tips/topic-service/api/v1/topics/search', { method: 'POST', body: JSON.stringify({ pagination: { pageSize: 25 }, sortorder: {} }) }); await tick(100);
  ok(e2.st.settings.pageSize === 40 && e2.st.settings.pageSizeSrc === 'manual', `manual page size kept (got ${e2.st.settings.pageSize}/${e2.st.settings.pageSizeSrc})`);
  e2.root().getElementById('s_detect').click(); await tick(100);
  ok(e2.st.settings.pageSize === 25 && e2.st.settings.pageSizeSrc === 'detected', `Re-detect switches back to the Reader's size (got ${e2.st.settings.pageSize}/${e2.st.settings.pageSizeSrc})`);
  process.exit();
})().catch(e => { console.error('ERROR', e); process.exit(1); });
