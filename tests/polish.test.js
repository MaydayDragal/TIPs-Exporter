// Polish items: focus handling, version, Check setup, open-after-reload, leftover settings.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');
async function fakeFetch(url) {
  const u = String(url);
  if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: 'o1' }) };
  return { ok: true, status: 200, json: async () => ({ totalHits: 0, hits: [] }) };
}
function makeEnv(extra = {}, path = '/tips-reader/search/topics') {
  const dom = new JSDOM(`<!doctype html><body>TIPS Reader v1.22.0 - 2026<xy-c-side-navigation><footer><xy-c-aux-menu id="auxMenu0"><div></div><button type="button" class="xy-test-standard-trigger">⋮</button></xy-c-aux-menu></footer></xy-c-side-navigation></body>`,
    { url: 'https://xentry.mercedes-benz.com' + path, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', pageSize: 20, pageSizeSrc: 'detected', pos: { left: 5, top: 5 } }, ...extra };
  w.TextEncoder = TextEncoder;
  w.chrome = { storage: { local: { get: async k => ({ [k]: st[k] }), set: async o => Object.assign(st, o) } },
    runtime: { getManifest: () => ({ version: '1.6.1' }), onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true; w.fetch = fakeFetch;
  // These legacy endpoint fixtures use zero-filled dummy PDFs; real scrubbing is covered by pdf-scrub.test.js.
  st.settings = { pdfScrub: { enabled: false }, ...st.settings };
  w.eval(probe); w.eval(fs.readFileSync(require('path').join(__dirname, '..', 'index-csv.js'), 'utf8')); w.eval(content);
  const root = () => [...w.document.documentElement.children].find(e => e.shadowRoot).shadowRoot;
  return { w, st, root, $: id => root().getElementById(id) };
}
const tick = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

(async () => {
  const e = makeEnv();
  await tick(150);
  ok(!('pos' in e.st.settings), 'old floating-panel position removed from saved settings');
  e.w.document.querySelector('#auxMenu0 button').focus();
  e.w.__toggle({ type: 'toggle' }, null, () => { }); await tick(30);
  ok(e.root().activeElement && e.root().activeElement.id === 'li', 'opening moves focus into the drawer (LI box)');
  ok(e.root().querySelector('.dr').getAttribute('aria-modal') === 'true', 'drawer is marked as a modal dialog');
  ok(/v1\.6\.1/.test(e.root().querySelector('.ft').textContent), 'footer shows the extension version');
  e.$('gear').click(); await tick(20);
  const help = e.root().querySelector('a[href*="github.com/MaydayDragal/TIPs-Exporter"]');
  ok(help && help.target === '_blank', 'Settings has a Help & instructions link');
  e.$('s_check').click(); await tick(20);
  const rows = [...e.root().querySelectorAll('.kv > div')].map(d => [...d.children].map(c => c.textContent.trim()).join(' | '));
  console.log('     ' + rows.join('\n     '));
  ok(rows.some(r => /✓ Session \| user u1/.test(r)) && rows.some(r => /✓ ⋮ menu \| found/.test(r)) && rows.some(r => /✓ Drawer position \| under the header/.test(r)) && rows.some(r => /Extension \| v1\.6\.1/.test(r)), 'Check setup reports session, ⋮ menu, drawer position and version');
  e.$('close').click(); await tick(20);
  ok(!e.root().querySelector('.dr') && e.w.document.activeElement === e.w.document.querySelector('#auxMenu0 button'), 'closing returns focus to the ⋮ button');

  // toolbar icon on a tab opened before the update: background sets openOnLoad and reloads -> drawer opens by itself
  const e2 = makeEnv({ openOnLoad: Date.now() - 2000 });
  await tick(600);
  ok(!!e2.root().querySelector('.dr') && e2.st.openOnLoad === 0, 'after the reload the drawer opens once, flag cleared');
  const e3 = makeEnv({ openOnLoad: Date.now() - 5 * 60000 });
  await tick(600);
  ok(!e3.root().querySelector('.dr'), 'a stale flag (older than a minute) is ignored');
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
