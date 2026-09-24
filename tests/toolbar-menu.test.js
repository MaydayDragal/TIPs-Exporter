// Topic-toolbar download button (option 2a) against a copy of the Reader's dialog markup.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = require('path').join(__dirname, '..') + '/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');
const OUT = __dirname + '/shots/'; fs.mkdirSync(OUT, { recursive: true });

const TOPIC = { tips: 'LI42.10-P-078779', tipsId: 242206748, version: 6, title: 'Repeat workshop visit for vehicle vibration under braking from 60MPH - Diagnostic Guide', modificationDate: 1 };
async function fakeFetch(url, init = {}) {
  const u = String(url);
  if (u.includes('/topics/search')) { const b = JSON.parse(init.body); const h = b.docName === TOPIC.tips ? [TOPIC] : []; return { ok: true, status: 200, json: async () => ({ totalHits: h.length, hits: h }) }; }
  if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: 'o1' }) };
  if (u.includes('/file/topics/')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(200 * 1024) };
  if (/\/topics\/242206748\/6\?/.test(u)) return { ok: true, status: 200, json: async () => ({ version: 6, i18nChangeReason: { en: 'Worksheet update. \nLanguage updates.' }, attachments: [{ attId: 1, filename: 'Repeat Brake Judder Data Gathering.pdf', dataUrl: 'https://x/y?readKey=rk1' }], references: [],
    history: { children: [{ version: 6, flowId: 'DRA', creationDate: '2026-09-16T16:56:36.714Z', i18nChangeReason: {} }, { version: 6, flowId: 'PUB', creationDate: '2026-09-21T15:37:16.433Z', i18nChangeReason: {} }, { version: 5, flowId: 'PUB', creationDate: '2026-05-15T12:39:51.58Z', i18nChangeReason: {} }] } }) };
  if (u.includes('/download/url')) return { ok: true, status: 200, json: async () => ({ url: 's3.example/f' }) };
  if (u.startsWith('https://s3.example/')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1024) };
  return { ok: false, status: 404 };
}
const ICON = 'style="width:48px;height:48px;border:0;background:#fff;color:#222"';
const dialogHtml = () => `
<div id="overlayHubContainer"><xy-c-dialog><div class="xy-c-picker"><neo-topic-detail><xy-c-dialog-body><div>
<header><div class="xy-pl-2 xy-d-flex" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px 8px 20px;font-family:Georgia,serif">
  <div><h2 style="margin:0;font-weight:400;font-size:24px"> Repeat workshop visit for vehicle vibration under braking from 60MPH - Diagnostic Guide </h2></div>
  <div class="xy-d-flex" style="display:flex;align-items:center">
    <xy-c-spinner><div class="xy-position-relative xy-d-inline-block"><button type="button" class="xy-button-reset xy-i-md xy-i-star" ${ICON}>☆</button></div></xy-c-spinner>
    <xy-c-spinner><div class="xy-position-relative xy-d-inline-block"><button type="button" class="xy-button-reset xy-i-md xy-i-print" ${ICON}>⎙</button></div></xy-c-spinner>
    <div class="xy-border-right" style="width:1px;height:30px;background:#ccc;margin:0 6px"></div>
    <xy-c-spinner><div class="xy-position-relative xy-d-inline-block"><button type="button" class="xy-i-close xy-button-reset" ${ICON}>✕</button></div></xy-c-spinner>
  </div></div></header>
<table style="font-family:Segoe UI,Arial;font-size:14px;margin:10px 20px"><tr><td style="width:300px;color:#555">Topic number</td><td>LI42.10-P-078779</td></tr><tr><td style="color:#555">Version</td><td>6</td></tr></table>
</div></xy-c-dialog-body></neo-topic-detail></div></xy-c-dialog></div>`;

function makeEnv(extra = {}) {
  const dom = new JSDOM(`<!doctype html><head></head><body style="margin:0">TIPS Reader v1.22.0 - 2026<xy-c-side-navigation><footer class="xy-border-top"><xy-c-aux-menu id="auxMenu0"><div></div><button type="button" class="xy-test-standard-trigger xy-i-more"></button></xy-c-aux-menu></footer></xy-c-side-navigation>${dialogHtml()}</body>`, { url: 'https://xentry.mercedes-benz.com/tips-reader/search/topics/242206748/6', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings: { outlet: 'o1', user: 'u1', ver: '1.22.0', delayMs: 100, delayMaxMs: 200, pageSize: 20, pageSizeSrc: 'detected' }, ...extra }, saved = [];
  w.TextEncoder = TextEncoder; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { saved.push(this.download); };
  w.chrome = { storage: { local: { get: async k => ({ [k]: st[k] }), set: async o => Object.assign(st, o) } }, runtime: { onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true; w.fetch = fakeFetch;
  let raf = 0; const r0 = w.requestAnimationFrame.bind(w); w.requestAnimationFrame = f => { raf++; return r0(f); };
  w.eval(probe); w.eval(content);
  const btns = () => [...w.document.querySelectorAll('button.tipsx-dl')];
  const fab = () => { const b = w.document.querySelector('#auxMenu0 .tipsx-rbadge'); return b ? b.dataset.kind : ''; };
  const shadow = () => [...w.document.documentElement.children].find(e => e.shadowRoot).shadowRoot;
  return { w, st, saved, btns, fab, shadow, raf: () => raf };
}
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(20); } }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

(async () => {
  const e = makeEnv({ index: [{ tips: TOPIC.tips, tipsId: TOPIC.tipsId, version: 6, title: TOPIC.title, mdate: 0 }] });
  await tick(150);
  let b = e.btns();
  ok(b.length === 1, 'one download button injected');
  const wrap = b[0].parentElement;
  ok(wrap.previousElementSibling && wrap.previousElementSibling.querySelector('.xy-i-print') && wrap.nextElementSibling.classList.contains('xy-border-right'), 'placed right after Print, before the divider');
  ok(b[0].getAttribute('aria-label').includes('Download this topic'), 'has an accessible label');
  const tipText = () => b[0].nextElementSibling.textContent;
  ok(tipText() === 'Download LI42.10-P-078779 – choose versions and attachmentsTIPS Exporter', 'tooltip: ' + tipText());

  // no feedback loop between our updates and the observer
  const r1 = e.raf(); await tick(600);
  ok(e.raf() - r1 <= 1, `page watcher is quiet when nothing changes (${e.raf() - r1} extra frames)`);

  // download: the button opens the version picker first (current version ticked, with its change reason)
  const pk = () => { for (const el of e.w.document.documentElement.children) { const r = el.shadowRoot, x = r && r.querySelector('.pk'); if (x) return x; } return null; };
  b[0].click();
  await waitFor(() => pk() && pk().querySelector('#p_go') && !pk().querySelector('#p_go').disabled);
  const ptxt = pk().textContent.replace(/\s+/g, ' ');
  ok([...pk().querySelectorAll('input[data-v]')].map(x => x.dataset.v + (x.checked ? '*' : '')).join() === '6*,5,4,3,2,1', 'toolbar button opens the picker: v6 … v1, only v6 ticked');
  ok(/Worksheet update\. Language updates\./.test(ptxt) && /Include attachments \(1 file\)/.test(ptxt) && b[0].getAttribute('aria-expanded') === 'true' && e.saved.length === 0, 'current version shows its change reason (from the topic data); nothing saved yet');
  pk().querySelector('#p_all').click(); pk().querySelector('#p_go').click();
  await waitFor(() => b[0].dataset.state === 'busy');
  ok(true, 'button shows busy spinner');
  await waitFor(() => e.fab() === 'busy');
  ok(true, 'rail ⋮ shows the blue downloading badge while the drawer is closed');
  await waitFor(() => b[0].dataset.state === 'done');
  ok(e.saved[0] === 'TIPS_LI42.10-P-078779.zip', 'zip saved: ' + e.saved[0]);
  ok(/^Saved TIPS_LI42\.10-P-078779\.zip \([\d.]+ MB\)/.test(tipText()) && b[0].parentElement.hasAttribute('data-show'), 'tooltip confirms save and stays visible');
  ok(e.fab() === 'done', 'rail ⋮ shows the green saved badge');
  ok(e.st.recent && e.st.recent[0].tips[0] === TOPIC.tips, 'added to Recent downloads');
  fs.writeFileSync(OUT + 'tb_done.html', '<!doctype html><meta charset="utf-8">' + e.w.document.head.innerHTML + '<body style="margin:0;width:1200px">' + e.w.document.getElementById('overlayHubContainer').outerHTML + '</body>');

  // Angular re-renders the dialog -> button comes back exactly once
  e.w.document.getElementById('overlayHubContainer').remove();
  await tick(50);
  e.w.document.body.insertAdjacentHTML('beforeend', dialogHtml());
  await tick(100);
  ok(e.btns().length === 1, 'button re-injected once after the dialog is re-rendered');

  // idle again after the done flash
  await tick(5200);
  b = e.btns();
  ok(b[0].dataset.state === 'idle', 'returns to idle');
  fs.writeFileSync(OUT + 'tb_idle.html', '<!doctype html><meta charset="utf-8">' + e.w.document.head.innerHTML.replace('</style>', '.tipsx-dlwrap .tipsx-tip{opacity:1}.tipsx-dl{background:#e8f1fd;color:#1f6fd1}</style>') + '<body style="margin:0;width:1200px;height:260px">' + e.w.document.getElementById('overlayHubContainer').outerHTML + '</body>');

  // ⋮ menu: our item is added under Settings each time the Reader builds the menu
  const menuHtml = () => `<div class="cdk-overlay-container"><div class="cdk-overlay-pane"><nav class="xy-c-aux-menu" id="auxMenu0-panel">
    <button xyauxmenuitem class="xy-base-button xy-i-learning"><span>Feature guide</span></button><button xyauxmenuitem class="xy-base-button xy-i-cog"><span>Settings</span></button>
    <button xyauxmenuitem class="xy-base-button xy-i-legal"><span>Disclaimer</span></button><button xyauxmenuitem class="xy-base-button xy-i-sign-out"><span>Log off</span></button></nav></div></div>`;
  let escs = 0, trig = 0;
  e.w.document.body.addEventListener('keydown', ev => { if (ev.key === 'Escape') escs++; });
  e.w.document.querySelector('#auxMenu0 button').addEventListener('click', () => { trig++; const o = e.w.document.querySelector('.cdk-overlay-container'); if (o) o.remove(); });
  for (let round = 1; round <= 2; round++) {
    e.w.document.body.insertAdjacentHTML('beforeend', menuHtml());
    await tick(80);
    const items = [...e.w.document.querySelectorAll('#auxMenu0-panel button')].map(b => (b.classList.contains('tipsx-menuitem') ? b.children[1] : b).textContent.trim());
    if (round === 1) ok(/Saved/.test(e.w.document.querySelector('.tipsx-mi-st').textContent), 'menu item shows the status (just saved)');
    ok(items.join('|') === 'Feature guide|Settings|TIPS Exporter|Disclaimer|Log off', `menu open #${round}: TIPS Exporter sits under Settings (${items.join(' | ')})`);
    ok(e.w.document.querySelector('.tipsx-menuitem').classList.contains('xy-base-button'), 'menu item reuses the Reader menu-item classes');
    if (round === 1) { e.w.document.querySelector('.tipsx-menuitem').click(); await tick(120); }
    else e.w.document.querySelector('.cdk-overlay-container').remove();
  }
  ok(escs >= 1 && trig >= 0, `clicking the item sends Escape to close the Reader menu (${escs} Escape, ${trig} trigger fallback)`);
  ok(!!e.shadow().querySelector('.dr') && !!e.shadow().querySelector('.dim'), 'clicking the item opens the drawer with the page dimmed');
  ok(e.shadow().querySelector('.dr').style.top === '0px' || e.shadow().querySelector('.dr').style.top === '56px', 'drawer starts under the header (' + e.shadow().querySelector('.dr').style.top + ')');
  e.shadow().getElementById('dim').click(); await tick(30);
  ok(!e.shadow().querySelector('.dr'), 'clicking the dimmed page closes the drawer');

  // no index: LI number read from the dialog; bulk batch pending -> refuses with a message
  const e2 = makeEnv({ index: [] });
  await tick(150);
  console.log('   e2 tip:', JSON.stringify(e2.btns()[0].nextElementSibling.textContent), e2.btns()[0].dataset.state);
  ok(e2.btns()[0].nextElementSibling.textContent.startsWith('Download LI42.10-P-078779 – choose versions'), 'without an index the LI number comes from the dialog');
  e2.btns()[0].click();
  { const go = () => { for (const el of e2.w.document.documentElement.children) { const x = el.shadowRoot && el.shadowRoot.querySelector('#p_go'); if (x) return x; } return null; };
    await waitFor(() => go() && !go().disabled); go().click(); }
  await waitFor(() => e2.btns()[0].dataset.state === 'done');
  ok(e2.saved[0] === 'TIPS_LI42.10-P-078779_v6.zip', 'download works without an index (current version: ' + e2.saved[0] + ')');
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
