// Cases test suite (jsdom). Run from a folder with jsdom installed: node tests/cases.test.js
// Cases: lookup, export (report + files), visible-history filtering, sanitising, toolbar button, read-only.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const SRC = 'C:/TIPs-Exporter/';
const probe = fs.readFileSync(SRC + 'pagesize-probe.js', 'utf8');
const content = fs.readFileSync(SRC + 'content.js', 'utf8');
const OUTLET = 'OUT1';
const ID = '246938001';
const T = (t, text, extra = {}) => ({ commonName: 'XXX', counter: 0, creationDate: t, lang: 'en', remark: null, sent: true, text, text2: null, text3: null, type: 0, uid: 'XXX', ...extra });
const msgs = [
  T('2026-09-22T11:39:07Z', '', { type: 100 }),
  T('2026-09-22T11:55:28Z', '<p>During PDI, found fault code C059468 current and stored.</p>', { type: 101, text2: '<p><br></p>', text3: '<p>Hello,</p><p>Guided test states replace N30/9 if frequency &gt; 2.</p>' }),
  T('2026-09-22T12:57:52Z', null, { type: 129, remark: 'UNKNOWN (unknown)' }),
  T('2026-09-22T12:58:11Z', null, { type: 123 }),
  T('2026-09-22T13:00:31Z', '', { type: 122, remark: '1790100044708' }),
  T('2026-09-22T13:00:31Z', '<p>**Launch** 2027 223 S580 C059468</p><p>No topic. </p>', { type: 200, remark: '24#PTS-Body/Chassis/Entertainment#XXX#XXX' }),
  T('2026-09-22T13:00:32Z', 'Thanks for opening a case. \n\nI have escalated this to the SE.<script>alert(1)</script><img src=x onerror="alert(2)">', { type: 132 }),
  T('2026-09-22T13:58:27Z', '<p>Afternoon XXX!! Launch 223M. INTERNAL-140</p>', { type: 140, remark: '1#GCSP/TPC Chassis-& Brakesystems#XXX#XXX' }),
  T('2026-09-22T13:58:28Z', '', { type: 122, remark: '1790186427214' }),
  T('2026-09-22T14:03:19Z', null, { type: 152, lang: 'de' }),
  T('2026-09-22T14:09:45Z', '<p>you are right this DTC has no influence INTERNAL-154</p>', { type: 154, lang: 'de', remark: '24#PTS-Body/Chassis/Entertainment#XXX#XXX' }),
  T('2026-09-22T16:17:22Z', '<p>Germany has informed me the DTC will be hidden.</p><p>OK to release the vehicle.</p>', { type: 126, remark: `24#${OUTLET}#XXX#XXX` }),
  T('2026-09-22T16:17:23Z', '', { type: 122, remark: '1790100007130' }),
  T('2026-09-22T16:44:39Z', 'Releasing vehicle to customer per GCSP.', { type: 107 }),
  T('2026-09-22T16:44:40Z', '', { type: 109 }),
  T('2026-09-22T17:43:06Z', 'INTERNAL-146 feedback', { type: 146 }),
  T('2026-09-22T17:43:07Z', '', { type: 128 })];
const att = (id, fn, d, t) => ({ id, filename: fn, wsDescription: d, creationDate: t, readKey: null, dataUrl: `https://xentry.mercedes-benz.com/ats/public/attachment/v1/read/download/redirect?readKey=rk-${id}` });
const CASE = {
  id: +ID, wsTitle: 'S580 - C059468 Electric motor A at the brake booster has a malfunction.', whsTitle: '**Launch** 2027 223 S580',
  creationDate: '2026-09-22T11:39:07Z', wsDeadline: '2026-09-22T18:00:07Z', summary: 'Symptom:\nDuring PDI, fault code C059468 …\n\nSolution:\nThe fault code will be hidden.',
  complaint: '<p>During PDI, found fault code C059468 current and stored.</p>', finding: '<p><br></p>', performedMeasure: '<p>Guided test states replace N30/9 if frequency &gt; 2.</p>',
  caseinvolveds: [{ category: 'HQ', teamId: 'GCSP/TPC', workstate: 'C' }, { category: 'WH', teamId: 'PTS-Body/Chassis/Entertainment', workstate: 'C' }, { category: 'WS', teamId: OUTLET, workstate: 'C' }],
  controlDeviceFaultCodes: [{ fcCode: 'C059468', fcText: 'Electric motor A at the brake booster has a malfunction.', cdText: 'N30/9 - Brake booster (BB)' }],
  symptom: { names: ['Chassis/suspension', 'Brake system', 'Service brake', 'Function', 'Brakes general'] },
  vehicle: { vin: 'W1K0000000TESTVIN', vehiclemodel: 'S 580 4MATIC Sedan (long wheelbase)', vs: '223.177', ve: '177.780', vt: '725.174', mileage: 11, proddate: '2026-08-13T00:00:00Z' },
  wsFeedback: { feedback: 'The DTC does not have any influence on system behavior. Releasing vehicle to customer per GCSP.' },
  hqInternalNote: 'HQ-NOTE-SECRET', whsInternalNote: 'WHS-NOTE-SECRET', internalNotes: [{ text: 'NOTE-SECRET' }],
  dealer: { contact: { email: 'dealer@example.com', phone: '555-0100' } },
  attachments: [att(11, 'XD_PROT_20260921_090504_Passenger car223177_TESTVIN_Control unit log cf185331cb52.pdf', 'CUL(BB)1', '2026-09-22T11:52:11Z'),
    att(7, 'XD_STPIE_20260921_090606_Passenger car223177_TESTVIN_Initial quick test cf1878f52653.pdf', 'Initial quick test with fault freeze frame data', '2026-09-22T11:52:11Z'),
    att(1, 'XD_SCCO_20260921_085005_Passenger car223177_TESTVIN_Whole page cf162f86d08c.pdf', 'C059468 GT', '2026-09-22T11:52:08Z')],
  history: { messages: msgs, modificationDate: '2026-09-22T17:43:06Z', allowedOperations: [{ contact: { method: 'PUT', href: 'x' } }] }
};
let extCalls = 0;
const EXT = { id: 'EXT7654321', wsTitle: 'RAMSES update fails – FLASH.CENTRAL_210004', summary: 'null', complaint: 'null', caseinvolveds: null, vehicle: null, attachments: [],
  history: { messages: [
    { commonName: null, creationDate: '2026-09-01T12:00:00Z', type: 101, text: '<p>Hi Timo,</p><p>Currently experiencing issues with the RAMSES update.</p>', text2: null, text3: null, remark: null },
    { commonName: null, creationDate: '2026-09-01T13:00:00Z', type: 132, text: 'Hi Joel,\n\nWhile the RAMSES Update is not essential, please open an XSS case.', remark: null },
    { commonName: null, creationDate: '2026-09-01T14:00:00Z', type: 107, text: 'Replaced RAMSES for failing update.', remark: null }] } };
const reqs = [];
async function fakeFetch(url, init = {}) {
  const u = String(url), method = (init.method || 'GET').toUpperCase();
  reqs.push({ method, u });
  if (u.includes('/currentuser')) return { ok: true, status: 200, json: async () => ({ userId: 'u1', currentOutlet: OUTLET }) };
  if (/\/external\/cases\/EXT7654321/.test(u)) {   // first two answers: TIPS still anonymizing
    extCalls++;
    const PH = 'anonymization is in progress...';
    // finished cases still carry the placeholder in fields the report doesn't use (names, dealer) – for good
    const done = { ...EXT, creator: { commonName: PH }, dealer: { name: PH, contact: { commonName: PH } }, history: { ...EXT.history, messages: EXT.history.messages.map(m => ({ ...m, commonName: PH })) } };
    const body = extCalls <= 2 ? { ...done, wsTitle: PH, history: { messages: EXT.history.messages.map(m => ({ ...m, text: PH })) } } : done;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  }
  if (/\/external\/cases\/STUCK123456/.test(u)) {   // the API never gets past the placeholders
    const PH = 'anonymization is in progress...';
    return { ok: true, status: 200, json: async () => ({ ...EXT, id: 'STUCK123456', wsTitle: PH, complaint: PH, vehicle: { vin: 'W1K.XXX', vehiclemodel: 'EQS 450+' }, history: { messages: EXT.history.messages.map(m => ({ ...m, text: PH })) } }) };
  }
  if (/\/external\/cases\/PART1234567/.test(u)) {   // one message never gets its text
    const PH = 'anonymization is in progress...', msgs = [...EXT.history.messages, { commonName: null, creationDate: '2026-09-01T15:00:00Z', type: 132, text: PH, remark: null }];
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify({ ...EXT, id: 'PART1234567', history: { messages: msgs } })) };
  }
  const m = u.match(/\/case-service\/api\/v1\/cases\/(\d+)\?/);
  if (m) { if (!/SourceAppID/i.test(JSON.stringify(init.headers || {}))) return { ok: false, status: 500 }; return m[1] === ID ? { ok: true, status: 200, json: async () => CASE } : { ok: false, status: 404 }; }
  if (u.includes('/download/url?readKey=')) return { ok: true, status: 200, json: async () => ({ url: 's3.example/' + u.split('readKey=')[1] }) };
  if (u.startsWith('https://s3.example/')) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 ' + u).buffer };
  return { ok: false, status: 404 };
}
function makeEnv(path, body = '') {
  const dom = new JSDOM(`<!doctype html><body>TIPS Reader v1.22.0 - 2026${body}</body>`, { url: 'https://xentry.mercedes-benz.com' + path, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, st = { settings: { outlet: OUTLET, user: 'u1', ver: '1.22.0', pageSize: 20, pageSizeSrc: 'detected', delayMs: 100, delayMaxMs: 150 } }, saved = [];
  w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = b => { saved.push({ blob: b }); return 'blob:x'; }; w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { saved[saved.length - 1].name = this.download; };
  w.chrome = { storage: { local: { get: async k => ({ [k]: st[k] }), set: async o => Object.assign(st, o) } }, runtime: { getManifest: () => ({ version: 'test' }), onMessage: { addListener(fn) { w.__toggle = fn; } } } };
  w.confirm = () => true; w.fetch = fakeFetch;
  w.eval(probe); w.eval(content);
  const root = () => [...w.document.documentElement.children].find(e => e.shadowRoot).shadowRoot;
  const env = { w, st, saved, root, $: id => root().getElementById(id) };
  env.text = () => { const r = root().querySelector('.dr'); if (!r) return ''; const tw = w.document.createTreeWalker(r, 4), a = []; while (tw.nextNode()) if (tw.currentNode.parentElement.tagName !== 'STYLE') a.push(tw.currentNode.textContent); return a.join(' ').replace(/\s+/g, ' '); };
  return env;
}
let W = null;
async function unzip(blob) {   // stored (uncompressed) zip reader
  const ab = await new Promise((res, rej) => { const fr = new W.FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsArrayBuffer(blob); });
  const buf = new Uint8Array(ab), dv = new DataView(buf.buffer), out = {};
  for (let o = 0; o + 30 <= buf.length && dv.getUint32(o, true) === 0x04034b50;) {
    const size = dv.getUint32(o + 18, true), nl = dv.getUint16(o + 26, true), xl = dv.getUint16(o + 28, true);
    const name = new TextDecoder().decode(buf.slice(o + 30, o + 30 + nl)); const start = o + 30 + nl + xl;
    out[name] = new TextDecoder().decode(buf.slice(start, start + size)); o = start + size;
  }
  return out;
}
const tick = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(20); } }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

(async () => {
  const e = makeEnv('/tips-reader/search/cases');
  await tick(120);
  e.w.__toggle({ type: 'toggle' }, null, () => { }); await tick(30);
  ok(!!e.$('tocases'), 'drawer has a Cases tab');
  e.$('tocases').click(); await tick(20);
  const cs = e.$('cs'); cs.value = `${ID}, 12345, 999999999`; cs.dispatchEvent(new e.w.Event('input'));
  e.$('clook').click(); await waitFor(() => e.$('cdl'));
  const t = e.text(); W = e.w;
  console.log('     card: ' + t.slice(t.indexOf('Found in TIPS'), t.indexOf('Found in TIPS') + 260));
  ok(/Found in TIPS : 1 of 3 entries/.test(t), 'lookup: 1 of 3 found');
  ok(new RegExp(`Case ${ID} Closed S580 - C059468`).test(t) && /S 580 4MATIC Sedan \(long wheelbase\) · VIN …ESTVIN · 3 files · 9 messages/.test(t), 'found card: title, status, model, VIN tail, 3 files, 9 visible messages');
  ok(/12345 Case numbers have 9 digits/.test(t) && /999999999 Not found, or not visible to your outlet/.test(t), 'problems explained');
  e.$('cdl').click();
  await waitFor(() => /Saved to Downloads/.test(e.text()));
  const z = e.saved.at(-1);
  ok(z.name === `TIPS_Case_${ID}.zip`, 'saved as ' + z.name);
  const files = await unzip(z.blob), names = Object.keys(files);
  console.log('     ' + names.join('\n     '));
  const base = names.find(n => n.endsWith('/Case report.html'));
  ok(!!base && names.filter(n => /\/Attachments\/.+\.pdf$/.test(n)).length === 3, 'zip: Case report.html + 3 uploaded files');
  ok(names.includes('_errors.txt') && /12345/.test(files['_errors.txt']), 'skipped entries listed in _errors.txt');
  const r = files[base];
  fs.writeFileSync(__dirname + '/shots/case_report.html', r);
  ok(/<h1>S580 - C059468 Electric motor A/.test(r) && /Closed/.test(r) && /W1K0000000TESTVIN/.test(r) && /S 580 4MATIC/.test(r), 'report: title, status, VIN, model');
  ok(/C059468<\/td><td>Electric motor A/.test(r) && /Brake system › Service brake/.test(r), 'report: fault code table, symptom path');
  ok(/Summary \(AI, as shown in TIPS\)/.test(r) && /<h2>Complaint<\/h2><p>During PDI/.test(r) && /<h2>Measures performed<\/h2>/.test(r) && !/<h2>Findings<\/h2>/.test(r), 'report: summary, complaint, measures (empty findings skipped)');
  const shown = (r.match(/<div class="ev(?: ws)?"><div class="eh"><b>/g) || []).length;
  ok(shown === 9, `report: 9 history messages as in TIPS (got ${shown})`);
  ok(/Message workshop → WhS/.test(r) && /<h4>Customer complaint<\/h4>/.test(r) && /<h4>Measures performed and results obtained<\/h4>/.test(r) && !/<h4>Workshop findings<\/h4>/.test(r), 'report: workshop message split into complaint / measures');
  ok((r.match(/Reply date set/g) || []).length === 3 && /Reply by /.test(r), 'report: reply dates shown as dates');
  ok(/Close WhS/.test(r) && /Close workshop/.test(r) && /Feedback, workshop → WhS completed/.test(r) && /OK to release the vehicle/.test(r), 'report: notifications, feedback and closing events');
  ok(!/INTERNAL-140|INTERNAL-154|INTERNAL-146|No topic\./.test(r), 'report: hidden WhS/HQ-internal messages left out');
  ok(!/NOTE-SECRET|dealer@example\.com|555-0100/.test(r), 'report: internal notes and dealer contact details left out');
  ok(/8 internal case events that TIPS doesn't show to the workshop are not included/.test(r), 'report footer says how many were left out');
  ok(!/<script|onerror|<img|alert\(/i.test(r) && /escalated this to the SE\./.test(r) && /8\/13\/2026/.test(r) && /9\/22\/26, 2:00 PM/.test(r), 'report: scripts and event handlers from message text stripped, text kept');
  ok(/<a href="Attachments\/XD_PROT_20260921_090504_Passenger%20car223177_TESTVIN_Control%20unit%20log%20cf185331cb52\.pdf">/.test(r), 'report links each uploaded file to its saved copy');
  ok(reqs.every(q => q.method === 'GET') && !reqs.some(q => /sendrequest|\/contact|\/author|summarization/.test(q.u)), 'read-only: only GET requests, no write or AI endpoints');
  ok(e.st.recent[0].kind === 'case' && e.st.recent[0].cases[0] === ID, 'recent download stored as a case');
  e.$('cnew').click(); await tick(20);
  ok(/Recent downloads Case 246938001/.test(e.text()), 'Cases tab shows recent case downloads');
  e.$('tosingle').click(); await tick(20);
  ok(!/Recent downloads Case/.test(e.text()), 'Single LI tab does not list case downloads');

  // toolbar button in an open case
  const dlg = `<neo-case-detail><xy-c-dialog-body><header><div><h2>Case communication</h2></div><div class="xy-d-flex">
    <xy-c-spinner><div><button class="xy-i-star"></button></div></xy-c-spinner><xy-c-spinner><div><button class="xy-i-info"></button></div></xy-c-spinner>
    <xy-c-spinner><div><button class="xy-i-print" style="width:48px;height:48px"></button></div></xy-c-spinner><xy-c-spinner><div><button class="xy-i-export" disabled></button></div></xy-c-spinner>
    <xy-c-spinner><div><button class="xy-i-support"></button></div></xy-c-spinner><div class="xy-border-right"></div><xy-c-spinner><div><button class="xy-i-close"></button></div></xy-c-spinner></div></header></xy-c-dialog-body></neo-case-detail>`;
  const e2 = makeEnv(`/tips-reader/search/cases/${ID}`, dlg);
  await tick(150);
  const b = e2.w.document.querySelector('button.tipsx-dl');
  ok(b && b.parentElement.previousElementSibling.querySelector('.xy-i-print') && b.parentElement.nextElementSibling.querySelector('.xy-i-export'), 'case toolbar: download button right after Print');
  ok(/Download this case/.test(b.getAttribute('aria-label')), 'case toolbar button label');
  b.parentElement.dispatchEvent(new e2.w.Event('mouseenter')); await tick(10);
  ok(/Download case 246938001: readable report \+ every uploaded file/.test(b.nextElementSibling.textContent), 'case toolbar tooltip');
  b.click();
  await waitFor(() => b.dataset.state === 'done');
  ok(e2.saved.at(-1).name === `TIPS_Case_${ID}.zip`, 'toolbar download saved the open case');
  // external case, limited reading view: no case number on screen or in the address
  const ext = `<neo-case-detail><xy-c-dialog-body><header><div><h2>Case communication</h2></div><div class="xy-d-flex">
    <xy-c-spinner><div><button class="xy-i-info"></button></div></xy-c-spinner><xy-c-spinner><div><button class="xy-i-print" style="width:48px;height:48px"></button></div></xy-c-spinner>
    <div class="xy-border-right"></div><xy-c-spinner><div><button class="xy-i-close"></button></div></xy-c-spinner></div></header><div>External case, limited reading view</div></xy-c-dialog-body></neo-case-detail>`;
  const e3 = makeEnv('/tips-reader/search/topics', ext);
  await tick(150);
  await e3.w.fetch('/tips/case-service/api/v1/cases?lang=en&folder=A&pageNumber=1', { method: 'GET' });          // list: must not count
  await e3.w.fetch('/tips/case-service/api/v1/external/cases/EXT7654321?lang=en&uid=u1', { method: 'GET' });   // the Reader loads the open case
  await e3.w.fetch('/tips/case-service/api/v1/cases/EXT7654321/request/sendtargets?lang=en', { method: 'GET' });  // side call: must not count
  ok(e3.w.document.documentElement.dataset.tipsxCaseUrl === '/tips/case-service/api/v1/external/cases/EXT7654321?lang=en&uid=u1', 'probe records the address the Reader loaded the open case from');
  const b3 = e3.w.document.querySelector('button.tipsx-dl');
  b3.click();
  await waitFor(() => b3.dataset.state === 'done' || b3.dataset.state === 'error');
  ok(b3.dataset.state === 'done' && e3.saved.at(-1).name === 'TIPS_Case_EXT7654321.zip', 'external case: toolbar download works (' + b3.nextElementSibling.textContent + ')');
  const f3 = await unzip(e3.saved.at(-1).blob), r3 = f3[Object.keys(f3).find(n => n.endsWith('Case report.html'))];
  ok(/RAMSES update fails/.test(r3) && /please open an XSS case/.test(r3) && (r3.match(/<div class="ev(?: ws)?"><div class="eh"><b>/g) || []).length === 3, 'external case report: title and all 3 messages');
  ok(!/>null<|undefined|NaN/.test(r3) && !/<h2>Summary|<h2>Complaint/.test(r3), 'external case report: "null" fields and missing fields leave nothing behind');
  ok(!/anonymization is in progress/i.test(r3) && extCalls === 3, `waited for TIPS to finish anonymizing (${extCalls} requests) – no placeholders saved, not stuck on names/dealer fields`);

  // one message stays anonymized: save after ~20 s with that message marked
  const e4 = makeEnv('/tips-reader/search/topics', ext);
  await tick(150);
  await e4.w.fetch('/tips/case-service/api/v1/external/cases/PART1234567?lang=en', { method: 'GET' });
  const b4 = e4.w.document.querySelector('button.tipsx-dl'), t4 = Date.now();
  b4.click();
  await tick(1200);
  ok(/Waiting for TIPS to finish anonymizing this case/.test(b4.nextElementSibling.textContent), 'tooltip says it is waiting for TIPS');
  await waitFor(() => b4.dataset.state === 'done' || b4.dataset.state === 'error', 40000);
  const secs = Math.round((Date.now() - t4) / 1000);
  W = e4.w;
  const f4 = await unzip(e4.saved.at(-1).blob), r4 = f4[Object.keys(f4).find(n => n.endsWith('Case report.html'))];
  ok(b4.dataset.state === 'done' && secs >= 19 && secs <= 30 && /\(anonymized by TIPS\)/.test(r4) && !/anonymization is in progress/i.test(r4), `mostly-finished case saved after ${secs} s, leftover placeholder marked "(anonymized by TIPS)"`);
  e4.w.__toggle({ type: 'toggle' }, null, () => { }); await tick(30); e4.$('gear').click(); await tick(20); e4.$('s_check').click(); await tick(20);
  const row4 = [...e4.root().querySelectorAll('.kv > div')].map(d => d.textContent).find(t => /Recent case requests/.test(t)) || '';
  ok(/GET \/tips\/case-service\/api\/v1\/external\/cases\/PART#######\?lang=en/.test(row4), 'Check setup lists the Reader\'s recent case requests (masked): ' + row4.replace(/\s+/g, ' ').slice(0, 120));
  W = e3.w;
  e3.w.__toggle({ type: 'toggle' }, null, () => { }); await tick(30); e3.$('gear').click(); await tick(20); e3.$('s_check').click(); await tick(20);
  const row = [...e3.root().querySelectorAll('.kv > div')].map(d => d.textContent).find(t => /Open case source/.test(t)) || '';
  ok(/external\/cases\/EXT#######\?lang=en&uid=…/.test(row), 'Check setup shows the case source with numbers and user masked: ' + row.replace(/\s+/g, ' '));
  // API stuck on placeholders, but TIPS shows the finished case: report is built from the case view
  const bubble = (right, head, date, body) => `<div class="${right ? 'speech-bubble-right' : 'speech-bubble'} xy-p-1"><div style="display:flex"><span><strong>${head}</strong> - (unknown) </span><span>${date}</span></div><div class="ql-editor">${body}</div></div><div class="xy-p-05"></div>`;
  const view = `<neo-case-detail><xy-c-dialog-body><header><div><h2>Case communication</h2></div><div class="xy-d-flex">
    <xy-c-spinner><div><button class="xy-i-info"></button></div></xy-c-spinner><xy-c-spinner><div><button class="xy-i-print" style="width:48px;height:48px"></button></div></xy-c-spinner>
    <div class="xy-border-right"></div><xy-c-spinner><div><button class="xy-i-close"></button></div></xy-c-spinner></div></header>
    <div>External case, limited reading view</div><neo-case-chat><div>No (AI) summary available!</div><div style="display:flex;flex-direction:column">
    ${bubble(false, 'Close workshop', '9/1/26', '')}
    ${bubble(false, 'Feedback, Workshop-&gt;WhS completed successfully', '9/1/26', 'Vehicle required replacement of A100/High Voltage LIB.<br><br>Remarks:<br>null')}
    ${bubble(true, 'Reply date set', '9/1/26', '9/2/26, 5:00 PM')}
    ${bubble(true, 'Notification WhS -&gt; workshop', '9/1/26', '<p>Good afternoon !PERSON!,</p><p>I have initiated the process for transportation of the NSFT battery.</p>')}
    <div class="speech-bubble-right xy-p-1"><div style="display:flex"><span><strong>New attachment (XD_PROT_20260901_Passen....pdf)</strong></span><span><strong><tn-attachment-preview><div><a target="_blank" href="https://xentry.mercedes-benz.com/ats/public/attachment/v1/read/download/redirect?readKey=rk-dom1&amp;filename=XD_PROT_20260901_Passenger" download="XD_PROT_20260901_Passenger car_HV battery log"></a></div></tn-attachment-preview></strong></span><span>9/1/26</span></div><div class="ql-editor">HV battery log</div></div>
    ${bubble(false, 'Message workshop-&gt;WhS', '9/1/26', '<p>Great morning, !PERSON!,</p><p>HV battery assessment attached.</p>')}
    </div></neo-case-chat></xy-c-dialog-body></neo-case-detail>`;
  const e5 = makeEnv('/tips-reader/search/topics', view);
  await tick(150);
  await e5.w.fetch('/tips/case-service/api/v1/external/cases/STUCK123456?lang=en', { method: 'GET' });
  const b5 = e5.w.document.querySelector('button.tipsx-dl'), t5 = Date.now();
  b5.click();
  await waitFor(() => b5.dataset.state === 'done' || b5.dataset.state === 'error', 20000);
  const s5 = Math.round((Date.now() - t5) / 1000);
  ok(b5.dataset.state === 'done' && s5 <= 10, `API stuck on placeholders: saved from the case view after ${s5} s (${b5.nextElementSibling.textContent})`);
  W = e5.w;
  const f5 = await unzip(e5.saved.at(-1).blob), n5 = Object.keys(f5), r5 = f5[n5.find(n => n.endsWith('Case report.html'))];
  console.log('     ' + n5.join('\n     '));
  const order = ['Message workshop-&gt;WhS', 'Notification WhS -&gt; workshop', 'Reply date set', 'Feedback, Workshop-&gt;WhS completed successfully', 'Close workshop'].map(x => r5.indexOf(x));
  ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'report: the 5 messages from the case view, oldest first, with TIPS\'s own labels');
  ok(/initiated the process for transportation of the NSFT battery/.test(r5) && /Good afternoon !PERSON!/.test(r5) && /9\/2\/26, 5:00 PM/.test(r5), 'report: message texts as TIPS shows them');
  ok(!/anonymization is in progress/i.test(r5) && !/Remarks:/.test(r5) && !/>null</.test(r5), 'report: no placeholders, no "Remarks: null"');
  ok(n5.some(n => /Attachments\/XD_PROT_20260901_Passenger car_HV battery log\.pdf$/.test(n)) && /HV battery log/.test(r5), 'uploaded file from the case view saved (extension restored) and listed');
  ok(/as shown in the TIPS case view \(external case, limited reading view\)/.test(r5) && /EQS 450\+/.test(r5), 'footer explains the source; vehicle kept from the case data');
  process.exit();
})().catch(err => { console.error('ERROR', err); process.exit(1); });
