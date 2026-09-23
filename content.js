/* TIPS Exporter – content script (runs in the logged-in TIPS Reader tab).
 * All requests use the Reader's own endpoints and the existing session cookies.
 * Nothing is downloaded until a batch is approved (unless Auto-approve is switched on).
 */
(() => {
  if (window.__TIPS_EXPORTER__) return;
  window.__TIPS_EXPORTER__ = true;

  // ---------------------------------------------------------------- storage
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(k, def) {
      try {
        if (hasChrome) { const o = await chrome.storage.local.get(k); return o[k] ?? def; }
        const v = localStorage.getItem('tipsx_' + k); return v ? JSON.parse(v) : def;
      } catch (e) { return def; }
    },
    async set(k, v) {
      try {
        if (hasChrome) return chrome.storage.local.set({ [k]: v });
        localStorage.setItem('tipsx_' + k, JSON.stringify(v));
      } catch (e) { console.warn('TIPS Exporter: storage failed', e); }
    }
  };

  // ---------------------------------------------------------------- state
  const S = {
    index: [],          // frozen list [{tips,tipsId,version,title,mdate}]
    done: {},           // tipsId -> {b: batch, d: iso date, v: version}
    history: [],        // [{n, fname, sizeMB, docs, ok, att, prev, errors, date}]
    recent: [],         // single-LI downloads [{fname, tips: [..], v, sizeMB, docs, date}]
    single: null,       // single-LI flow: {phase: 'looking'|'looked'|'done', ...}
    settings: { outlet: '', user: '', ver: '', batchSize: 25, delayMs: 2000, delayMaxMs: 5000, pageSize: 50, pageSizeSrc: 'default',
      autoApprove: false, autoContinue: true,
      files: { docJson: true, attCsv: true, histCsv: true, histJson: true, manifest: true } },
    run: null,          // {n, i, total, label, paused, cancel}
    pending: null,      // prepared batch awaiting approval {n, blob, fname, summary, results}
    msg: ''
  };
  const DEFAULT_SEARCH = { fuzzyActive: true, correlationId: 4, fallbackLang: 'en', area: 'WS', creator: null, sortorder: { field: 'mdate', order: 'desc' }, lang: { lang: 'en' }, countries: ['US'], vehicleContext: {}, timefilter: {}, docName: '', workstate: '', brandNames: ['Maybach', 'Mercedes-Benz'], productGroupNames: ['PKW', 'Supersportwagen'], pagination: { pageNumber: 1, pageSize: 50 }, drilldowns: [{ key: 'country', identifier: 'US' }], favFilterActive: false, searchField: 'all', provideNavigation: 'full', totalHitsCountOnly: false, useAi: false };

  async function load() {
    S.index = await store.get('index', []);
    S.done = await store.get('done', {});
    S.history = await store.get('history', []);
    S.recent = await store.get('recent', []);
    const saved = await store.get('settings', {});
    S.settings = { ...S.settings, ...saved, files: { ...S.settings.files, ...(saved.files || {}) } };
    if (saved.delayMaxMs === undefined) {   // pre-1.3 settings had one fixed delay (default 250 ms)
      S.settings.delayMs = Math.max(+saved.delayMs || 0, 2000); S.settings.delayMaxMs = S.settings.delayMs + 3000;
    }
    detectSession();
    notePageSize(+document.documentElement.dataset.tipsxPageSize);
  }
  const saveIndex = () => store.set('index', S.index);
  const saveDone = () => store.set('done', S.done);
  const saveHistory = () => store.set('history', S.history);
  const saveRecent = () => store.set('recent', S.recent);
  const saveSettings = () => store.set('settings', S.settings);

  // ---------------------------------------------------------------- session detection
  function detectSession() {
    const s = S.settings;
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (!e.name.includes('currentOutlet=')) continue;
        const u = new URL(e.name);
        s.outlet = u.searchParams.get('currentOutlet') || s.outlet;
        s.user = u.searchParams.get('user') || s.user;
        break;
      }
    } catch (e) { }
    const m = (document.body && document.body.innerText || '').match(/\bv(\d+\.\d+\.\d+)\s*-\s*\d/);
    if (m) s.ver = m[1];
    if (!s.ver) s.ver = '1.22.0';
  }
  // Page size the Reader itself uses for topic search, reported by pagesize-probe.js (runs in the page's world).
  function notePageSize(n) {
    const s = S.settings;
    if (!Number.isInteger(n) || n < 1 || s.pageSizeSrc === 'manual' || (s.pageSize === n && s.pageSizeSrc === 'detected')) return false;
    s.pageSize = n; s.pageSizeSrc = 'detected';
    return true;
  }
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.__tipsx !== 'pageSize') return;
    if (notePageSize(e.data.size)) { saveSettings(); if (visible) render(); }
  });
  async function detectUserFallback() {
    if (S.settings.user) return;
    try {
      const r = await fetch('/tips/common-service/api/v1/xentry/currentuser', { credentials: 'include', headers: { Accept: 'application/json' } });
      const j = await r.json();
      S.settings.user = j.userId || j.id || j.uid || j.user || S.settings.user;
      S.settings.outlet = S.settings.outlet || j.currentOutlet || j.outletId || j.outlet || '';
    } catch (e) { }
  }
  const Q = () => `currentOutlet=${encodeURIComponent(S.settings.outlet)}&lang=en&user=${encodeURIComponent(S.settings.user)}`;
  const H = () => ({ Accept: 'application/json', 'Content-Type': 'application/json', SourceAppID: 'neo-reader', 'X-TIPS-Version': S.settings.ver, 'X-TIPS-ui': 'reader' });
  const sessionOK = () => !!(S.settings.outlet && S.settings.user && S.settings.ver);

  // ---------------------------------------------------------------- helpers
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const randDelay = () => { const lo = S.settings.delayMs, hi = Math.max(lo, S.settings.delayMaxMs); return lo + Math.random() * (hi - lo); };
  const enc = new TextEncoder();
  const txt = s => enc.encode(s);
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const safe = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90).replace(/[. ]+$/, '');
  const csvEsc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const loc = o => o ? (o.en || Object.values(o)[0] || '') : '';
  const pad3 = n => String(n).padStart(3, '0');
  // Batches = the next `batchSize` pending documents in index order. Progress is tracked per document,
  // so the batch size can be changed at any time without losing or repeating anything.
  const pendingItems = () => S.index.filter(x => !S.done[x.tipsId]);
  const doneCount = () => S.index.reduce((a, x) => a + (S.done[x.tipsId] ? 1 : 0), 0);
  const lastBatchNo = () => Math.max(0, ...Object.values(S.done).map(d => +d.b || 0), ...S.history.map(h => +h.n || 0));
  function nextBatch() { return pendingItems().length ? lastBatchNo() + 1 : null; }
  const remainingBatches = () => Math.ceil(pendingItems().length / S.settings.batchSize);
  class SessionError extends Error { }

  function makeZip(files) {
    const parts = [], central = []; let off = 0;
    for (const f of files) {
      const nm = enc.encode(f.name), d = f.data, crc = crc32(d);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true);
      lh.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(lh.buffer), nm, d);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true);
      ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + d.length;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }

  async function get(url, accept, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, { credentials: 'include', headers: { ...H(), Accept: accept } });
        if (r.status === 401 || r.status === 403 || r.redirected && /login|auth/i.test(r.url)) throw new SessionError('Session expired or not authorised (HTTP ' + r.status + ')');
        if (r.ok || r.status < 500) return r;
        last = 'HTTP ' + r.status;
      } catch (e) { if (e instanceof SessionError) throw e; last = e.message; }
      await sleep(1500 * (i + 1));
    }
    throw new Error(last || 'request failed');
  }
  function saveBlob(blob, fname) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ---------------------------------------------------------------- index
  // One pass, oldest-modified first, paged with the Reader's own page size. Oldest-first means a topic
  // edited or added mid-run moves to the end (still reached) instead of shifting pages already read.
  async function fetchAllTopics() {
    const size = S.settings.pageSize, m = new Map(); let total = 0, hits = 0;
    for (let p = 1; p <= 2000; p++) {
      setMsg(`Searching TIPS… page ${p}${total ? ' of ' + Math.ceil(total / size) : ''}`);
      const r = await fetch('/tips/topic-service/api/v1/topics/search?' + Q(), { method: 'POST', credentials: 'include', headers: H(), body: JSON.stringify({ ...DEFAULT_SEARCH, sortorder: { field: 'mdate', order: 'asc' }, pagination: { pageNumber: p, pageSize: size } }) });
      if (r.status === 401 || r.status === 403) throw new SessionError('Session expired (HTTP ' + r.status + ')');
      if (!r.ok) throw new Error('Search failed: HTTP ' + r.status);
      const j = await r.json(); total = j.totalHits;
      if (!j.hits || !j.hits.length) break;
      hits += j.hits.length;
      for (const h of j.hits) if (!m.has(h.tipsId)) m.set(h.tipsId, { tips: h.tips, tipsId: h.tipsId, version: h.version, title: h.title, mdate: h.modificationDate });
      if (hits >= total) break;
      await sleep(300);
    }
    const short = hits < total ? ` ⚠ TIPS reported ${total} hits but only ${hits} came back – some topics may be missing; run "Check new" later to pick them up.` : '';
    return { list: [...m.values()], total, short };
  }
  // Before the Reader has run a search in this tab its page size is unknown; ask before using the fallback.
  function pageSizeOK() {
    const s = S.settings;
    if (notePageSize(+document.documentElement.dataset.tipsxPageSize)) saveSettings();
    return s.pageSizeSrc !== 'default' || confirm(`The Reader's own search page size hasn't been seen in this tab yet, so the exporter would page through results ${s.pageSize} at a time.\n\nTo match the Reader instead, click Cancel, run any search in TIPS, then try again.\n\nContinue with ${s.pageSize} per page?`);
  }
  async function buildIndex() {
    if (S.index.length && !confirm('An index already exists. Rebuilding re-sorts everything and can shift batch numbers. Use "Check new" instead unless you are starting over.\n\nRebuild anyway?')) return;
    if (!pageSizeOK()) return;
    setMsg('Building index…');
    const { list, total, short } = await fetchAllTopics();
    S.index = list.sort((a, b) => a.tips.localeCompare(b.tips));
    await saveIndex();
    setMsg(`Index built: ${S.index.length} unique topics (${total} search hits), ${remainingBatches()} batches to go at ${S.settings.batchSize} per batch.` + short);
  }
  async function refreshIndex() {
    if (!pageSizeOK()) return;
    setMsg('Checking for new or updated topics…');
    const { list, short } = await fetchAllTopics();
    const byId = new Map(S.index.map(x => [x.tipsId, x]));
    let updated = 0, reexport = 0; const fresh = [];
    for (const x of list) {
      const cur = byId.get(x.tipsId);
      if (!cur) { fresh.push(x); continue; }
      if (x.version !== cur.version) {
        cur.version = x.version; cur.title = x.title; cur.mdate = x.mdate; updated++;
        if (S.done[cur.tipsId]) { delete S.done[cur.tipsId]; reexport++; }
      }
    }
    fresh.sort((a, b) => a.tips.localeCompare(b.tips));
    S.index = S.index.concat(fresh);
    await saveIndex(); await saveDone();
    setMsg(`${fresh.length} new topic(s) appended at the end; ${updated} topic(s) have a newer version` + (reexport ? ` (${reexport} already-exported one(s) re-queued)` : '') + '.' + short);
  }

  // ---------------------------------------------------------------- log import/export
  function parseCsv(text) {
    return text.trim().split(/\r?\n/).slice(1).map(l => (l.match(/"((?:[^"]|"")*)"/g) || []).map(c => c.slice(1, -1).replace(/""/g, '"')));
  }
  async function importLog(text) {
    const rows = parseCsv(text);
    if (!rows.length || rows[0].length < 8) throw new Error('This does not look like _progress_log_all_documents.csv');
    const idx = [], done = {};
    for (const [i, b, tips, tipsId, version, title, mdate, status, date] of rows) {
      const it = { tips, tipsId: +tipsId, version: +version, title, mdate };
      idx.push(it);
      if (status === 'exported') done[it.tipsId] = { b: +b, d: date, v: +version };
    }
    S.index = idx; S.done = done;
    await saveIndex(); await saveDone();
    setMsg(`Imported log: ${idx.length} topics, ${Object.keys(done).length} already exported. Next batch: ${nextBatch() ?? '— (all done)'}.`);
  }
  function progressCsv(doneMap = S.done) {
    const log = ['index,batch,tips,tipsId,version_indexed,title,modification_date,status,exported_on'];
    S.index.forEach((x, i) => { const s = doneMap[x.tipsId]; log.push([i + 1, s ? s.b : '', x.tips, x.tipsId, x.version, x.title, x.mdate, s ? 'exported' : 'pending', s ? s.d : ''].map(csvEsc).join(',')); });
    return log.join('\r\n');
  }

  // ---------------------------------------------------------------- export one document
  async function exportDoc(item, files, errors, step) {
    const base = `${safe(item.tips)} - ${safe(item.title)}`;
    step('topic data', { g: 'data' });
    const jr = await get(`/tips/topic-service/api/v1/topics/${item.tipsId}/${item.version}?${Q()}`, 'application/json');
    if (!jr.ok) throw new Error('topic data HTTP ' + jr.status);
    const doc = await jr.json();
    const v = doc.version || item.version;
    const F = S.settings.files;
    if (F.docJson) files.push({ name: `${base}/${safe(item.tips)}_v${v}.json`, data: txt(JSON.stringify(doc, null, 2)) });

    step(`PDF v${v}`, { g: 'pdf', v });
    const pr = await get(`/tips/topic-service/api/v1/file/topics/${item.tipsId}/${v}?${Q()}`, 'application/pdf');
    if (pr.ok) files.push({ name: `${base}/${safe(item.tips)}_v${v}.pdf`, data: new Uint8Array(await pr.arrayBuffer()) });
    else errors.push(`${item.tips}: current PDF HTTP ${pr.status}`);

    const atts = doc.attachments || [], refs = doc.references || [];
    let nAtt = 0;
    if (atts.length || refs.length) {
      const dir = `${base}/Attachments and Links`;
      const lines = ['type,filename_or_target,description,created'];
      const used = new Set();
      for (const [k, a] of atts.entries()) {
        let fn = safe(a.filename || ('attachment_' + a.attId)); while (used.has(fn.toLowerCase())) fn = '_' + fn; used.add(fn.toLowerCase());
        lines.push([a.type, fn, loc(a.i18nDescription), a.creationDate].map(csvEsc).join(','));
        step(`attachment ${k + 1}/${atts.length}`, { g: 'att', k: k + 1, n: atts.length });
        try {
          const rk = new URL(a.dataUrl).searchParams.get('readKey');
          const ur = await get('/ats/public/attachment/v1/read/download/url?readKey=' + encodeURIComponent(rk), 'application/json');
          if (!ur.ok) throw new Error('url HTTP ' + ur.status);
          const uj = await ur.json(); const s3 = uj.url.startsWith('http') ? uj.url : 'https://' + uj.url;
          const br = await fetch(s3); if (!br.ok) throw new Error('HTTP ' + br.status);
          files.push({ name: `${dir}/${fn}`, data: new Uint8Array(await br.arrayBuffer()) }); nAtt++;
        } catch (e) { if (e instanceof SessionError) throw e; errors.push(`${item.tips}: attachment "${fn}" ${e.message}`); }
      }
      for (const r of refs) lines.push(['link/reference', r.tips || r.target || r.url || r.docNumber || JSON.stringify(r), loc(r.i18nTitle) || r.title || '', ''].map(csvEsc).join(','));
      if (F.attCsv) files.push({ name: `${dir}/_attachments_and_links.csv`, data: txt(lines.join('\r\n')) });
    }

    const hist = (doc.history && doc.history.children) || [];
    const rdir = `${base}/Revision History`;
    const flow = { DRA: 'Draft', REA: 'Ready/Review', PUB: 'Published', BLO: 'Blocked/Superseded' };
    const hl = ['version,step,date,creator,location,change_reason,block_reason'];
    for (const h of hist) hl.push([h.version, flow[h.flowId] || h.flowId, h.creationDate, h.creator && h.creator.fullname, h.location, loc(h.i18nChangeReason), loc(h.i18nBlockReason)].map(csvEsc).join(','));
    if (F.histCsv) files.push({ name: `${rdir}/revision_history.csv`, data: txt(hl.join('\r\n')) });
    if (F.histJson) files.push({ name: `${rdir}/revision_history.json`, data: txt(JSON.stringify(doc.history || {}, null, 2)) });
    let nPrev = 0;
    for (let pv = 1; pv < v; pv++) {
      step(`prior version v${pv}`, { g: 'prior', k: pv, n: v - 1 });
      try {
        const r = await get(`/tips/topic-service/api/v1/file/topics/${item.tipsId}/${pv}?${Q()}`, 'application/pdf');
        if (r.ok) { files.push({ name: `${rdir}/${safe(item.tips)}_v${pv}.pdf`, data: new Uint8Array(await r.arrayBuffer()) }); nPrev++; }
        else errors.push(`${item.tips}: v${pv} PDF HTTP ${r.status}`);
      } catch (e) { if (e instanceof SessionError) throw e; errors.push(`${item.tips}: v${pv} ${e.message}`); }
      await sleep(150);
    }
    return { version: v, attachments: nAtt, attachmentsListed: atts.length, links: refs.length, prevVersions: nPrev, histEvents: hist.length };
  }

  // ---------------------------------------------------------------- run documents -> zip
  // Exports `items` one by one with pause/cancel support. Returns {files, errors, results} or null if stopped.
  async function runDocs(title, items, kind = 'bulk') {
    const files = [], errors = [], results = [];
    S.run = { title, kind, items, results, i: 0, total: items.length, label: '', step: null, attN: 0, paused: false, cancel: false };
    render();
    try {
      for (const [k, it] of items.entries()) {
        if (k) {
          const until = Date.now() + randDelay();
          while (Date.now() < until && !S.run.cancel) {
            S.run.step = null; S.run.attN = 0;
            S.run.label = `waiting ${Math.ceil((until - Date.now()) / 1000)} s before next document`; renderProgress();
            await sleep(Math.min(250, until - Date.now()));
          }
        }
        while (S.run.paused && !S.run.cancel) await sleep(400);
        if (S.run.cancel) throw new Error('cancelled');
        S.run.i++; S.run.label = it.tips; S.run.step = null; S.run.attN = 0; render();
        try {
          const r = await exportDoc(it, files, errors, (s, info) => {
            S.run.label = `${it.tips} – ${s}`; S.run.step = info || null;
            if (info && info.g === 'att') S.run.attN = info.n;
            if (S.run.kind === 'single') render(); else renderProgress();
          });
          results.push({ ...it, ...r, status: 'ok' });
        } catch (e) {
          if (e instanceof SessionError) throw e;
          results.push({ ...it, status: 'FAILED: ' + e.message }); errors.push(`${it.tips}: ${e.message}`);
        }
      }
    } catch (e) {
      S.run = null;
      if (e instanceof SessionError) setMsg('⚠ ' + e.message + '. Log in to XENTRY again (keep this tab), then retry.');
      else setMsg(e.message === 'cancelled' ? `${title} cancelled – nothing saved.` : `${title} failed: ` + e.message);
      render(); return null;
    }
    S.run = null;
    return { files, errors, results };
  }
  function manifestCsv(results) {
    const man = ['tips,title,version,attachments_saved,attachments_listed,links,prior_versions_saved,history_events,status'];
    for (const r of results) man.push([r.tips, r.title, r.version, r.attachments, r.attachmentsListed, r.links, r.prevVersions, r.histEvents, r.status].map(csvEsc).join(','));
    return man.join('\r\n');
  }
  function summarize(fname, blob, results, errors) {
    const ok = results.filter(r => r.status === 'ok');
    return { fname, sizeMB: +(blob.size / 1048576).toFixed(2), docs: results.length, ok: ok.length, range: results.length ? `${results[0].tips} → ${results[results.length - 1].tips}` : '', att: ok.reduce((a, r) => a + r.attachments, 0), prev: ok.reduce((a, r) => a + r.prevVersions, 0), errors };
  }

  // ---------------------------------------------------------------- bulk batch (next N pending docs)
  async function prepareBatch() {
    if (S.run || S.pending) return;
    if (!sessionOK()) { setMsg('Session values missing – open Settings and fill Outlet / User, or open any topic once so they can be detected.'); return; }
    const items = pendingItems().slice(0, S.settings.batchSize);
    if (!items.length) { setMsg('Everything in the index is exported.'); return; }
    const n = nextBatch();
    const out = await runDocs(`Batch ${n}`, items, 'bulk');
    if (!out) return;
    const { files, errors, results } = out;
    const now = new Date().toISOString();
    const provisional = { ...S.done };
    for (const r of results) if (r.status === 'ok') provisional[r.tipsId] = { b: n, d: now, v: r.version };
    const p = pad3(n);
    files.unshift({ name: `_progress_log_all_documents.csv`, data: txt(progressCsv(provisional)) });   // always included: needed to resume
    if (S.settings.files.manifest) files.unshift({ name: `_batch_${p}_manifest.csv`, data: txt(manifestCsv(results)) });
    if (errors.length) files.unshift({ name: `_batch_${p}_errors.txt`, data: txt(errors.join('\r\n')) });
    const blob = makeZip(files);
    const fname = `TIPS_LI_Batch_${p}.zip`;
    S.pending = { kind: 'batch', n, blob, fname, results, summary: summarize(fname, blob, results, errors) };
    setMsg(`Batch ${n} ready for review.`);
    render();
    if (S.settings.autoApprove) approve();
  }
  async function approve() {
    const p = S.pending; if (!p) return;
    saveBlob(p.blob, p.fname);
    const now = new Date().toISOString();
    for (const r of p.results) if (r.status === 'ok') S.done[r.tipsId] = { b: p.n, d: now, v: r.version };
    S.history.push({ ...p.summary, n: p.n, errors: p.summary.errors.length, date: now });
    await saveDone(); await saveHistory();
    S.pending = null;
    setMsg(`Downloaded ${p.fname}.`);
    render();
    if (S.settings.autoContinue && nextBatch()) setTimeout(() => prepareBatch(), 800);
  }
  function discard() {
    if (!S.pending) return;
    setMsg(`Discarded ${S.pending.fname} – those documents stay pending.`);
    S.pending = null; render();
  }

  // ---------------------------------------------------------------- specific LI download
  const FULL_NO = /^[A-Z]{2}\d{2}\.\d{2}-[A-Z]-\d{6}$/;
  async function searchByNumber(no) {
    const r = await fetch('/tips/topic-service/api/v1/topics/search?' + Q(), { method: 'POST', credentials: 'include', headers: H(), body: JSON.stringify({ ...DEFAULT_SEARCH, docName: no, pagination: { pageNumber: 1, pageSize: 10 } }) });
    if (r.status === 401 || r.status === 403) throw new SessionError('Session expired (HTTP ' + r.status + ')');
    if (!r.ok) throw new Error('search HTTP ' + r.status);
    const j = await r.json();
    const h = (j.hits || []).find(x => String(x.tips).toUpperCase() === no);
    return h ? { tips: h.tips, tipsId: h.tipsId, version: h.version, title: h.title, mdate: h.modificationDate } : null;
  }
  // Accepts full numbers (LI42.10-P-078779) or a unique fragment (078779, 42.10-P-0787…) matched against the index.
  // Problems are structured for the panel: {token, kind, text, matches, count, msg} (msg = one line for _errors.txt).
  async function resolveNumbers(text) {
    const tokens = [...new Set(text.split(/[\s,;]+/).map(t => t.trim().toUpperCase()).filter(Boolean))];
    const found = [], problems = [];
    for (const t of tokens) {
      let no = FULL_NO.test(t) ? t : null;
      if (!no) {
        const m = S.index.filter(x => x.tips.toUpperCase().includes(t));
        if (m.length === 1) no = m[0].tips.toUpperCase();
        else if (m.length) { problems.push({ token: t, kind: 'ambiguous', text: `Matches ${m.length} topics. Type more of the number.`, matches: m.slice(0, 3).map(x => x.tips), count: m.length, msg: `${t}: matches ${m.length} topics (${m.slice(0, 3).map(x => x.tips).join(', ')}${m.length > 3 ? '…' : ''}) – be more specific` }); continue; }
        else { const text = S.index.length ? 'Not found in the index.' : 'Enter the full number (e.g. LI42.10-P-078779), or build the index first.'; problems.push({ token: t, kind: 'notfound', text, msg: `${t}: ${text}` }); continue; }
      }
      const hit = await searchByNumber(no);           // always fetch the CURRENT version from TIPS
      if (hit) { if (!found.some(f => f.tipsId === hit.tipsId)) found.push({ ...hit, src: no === t ? '' : t }); }
      else problems.push({ token: t, kind: 'notfound', text: 'Not found in TIPS search.', msg: `${no}: not found in TIPS search` });
    }
    return { found, problems };
  }
  const selectionName = found => found.length === 1 ? `TIPS_${safe(found[0].tips)}.zip` : `TIPS_selection_${new Date().toISOString().slice(0, 10)}_${found.length}docs.zip`;
  async function lookupSpecific(text) {
    if (S.run || S.pending) { setMsg('Finish or discard the bulk batch first.'); return; }
    if (!sessionOK()) { setMsg('Session values missing – open ⚙ Settings.'); return; }
    if (!text.trim()) { setMsg('Enter one or more LI numbers.'); return; }
    S.single = { phase: 'looking' }; render();
    try {
      const { found, problems } = await resolveNumbers(text);
      S.single = { phase: 'looked', found, problems };
    } catch (e) { S.single = null; throw e; }
    render();
  }
  async function downloadFound() {
    const sg = S.single;
    if (!sg || sg.phase !== 'looked' || !sg.found.length || S.run || S.pending) return;
    const { found, problems } = sg;
    const out = await runDocs(found.length === 1 ? found[0].tips : `${found.length} documents`, found, 'single');
    if (!out) return;   // cancelled or session lost: runDocs set the message; the looked-up list stays
    const { files, errors, results } = out;
    if (S.settings.files.manifest) files.unshift({ name: `_manifest.csv`, data: txt(manifestCsv(results)) });
    if (errors.length || problems.length) files.unshift({ name: `_errors.txt`, data: txt([...problems.map(p => p.msg), ...errors].join('\r\n')) });
    const blob = makeZip(files);
    const fname = selectionName(found);
    saveBlob(blob, fname);   // explicit request -> download straight away; does not change bulk-export progress
    const sum = summarize(fname, blob, results, errors);
    S.single = { phase: 'done', fname, sum, problems };
    S.recent.unshift({ fname, tips: found.map(f => f.tips), v: found.length === 1 ? found[0].version : null, sizeMB: sum.sizeMB, docs: found.length, date: new Date().toISOString() });
    S.recent = S.recent.slice(0, 10);
    await saveRecent();
    render();
  }

  // ---------------------------------------------------------------- UI
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'open' });
  let visible = false, showSettings = false, liText = '', view = 'single';   // view: 'single' | 'bulk'
  let fabFlash = null;   // {text, until}: short status on the minimised button after a toolbar download
  // Palette: navy fur, azure stripes, sky highlights, white belly, black legs.
  const css = `
  :host{all:initial;--bg:#0d1633;--line:#22346a;--row:#14214a;--inset:#0a1128;--edge:#2e4584;--btn2:#1a2a5c;--foot:#070c1c;
    --tx:#f4f7ff;--tx2:#dbe5fb;--mut:#a9bde6;--dim:#5b6fa8;--sky:#8fc3f0;--acc:#2e8ff0;--ink:#08143a;--cur:#1f5fb8;
    --ok:#4cc38a;--okbg:#16352a;--warn:#ffc47a;--warnbg:#2a1f14;--warnbd:#6b4a1f;--bad:#ff9c94;--badbd:#6e3a3a}
  *{box-sizing:border-box;font-family:Barlow,"Segoe UI",system-ui,sans-serif}
  .mono,textarea,code,pre{font-family:"JetBrains Mono",Consolas,ui-monospace,monospace}
  .num,.h{font-family:"Barlow Condensed",Bahnschrift,"Arial Narrow",sans-serif;font-weight:600;line-height:1}
  .fab{display:flex;align-items:center;gap:8px;background:var(--bg);color:var(--tx);border:1px solid var(--line);border-top:3px solid var(--acc);border-radius:20px;padding:8px 14px;font-size:13px;font-weight:600;letter-spacing:.02em;cursor:grab;box-shadow:0 6px 18px rgba(0,0,0,.35);user-select:none}
  .mark{width:10px;height:10px;border-radius:2px;background:var(--acc);flex:none}
  .panel{width:400px;max-height:calc(100vh - 24px);overflow:auto;background:var(--bg);color:var(--tx);border:1px solid var(--line);border-top:3px solid var(--acc);border-radius:10px;box-shadow:0 14px 36px rgba(0,0,0,.35);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 6px 6px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);cursor:grab;user-select:none;z-index:1}
  header.dragging,.fab.dragging{cursor:grabbing}
  .brand{display:flex;align-items:center;gap:10px;min-width:0} .brand b{font-size:15px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
  .status{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ib{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;background:none;border:0;border-radius:6px;color:var(--mut);cursor:pointer;flex:none}
  .ib:hover{background:var(--row);color:var(--tx)} .ib:disabled{opacity:.4;cursor:default;background:none}
  section{padding:14px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:10px}
  .lbl{font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--sky);text-transform:uppercase}
  .h{font-size:24px;line-height:1.1}
  .mut{color:var(--mut);font-size:12px} .dim{color:var(--dim)} .tx2{color:var(--tx2)}
  .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .acc{color:var(--acc)}
  textarea{width:100%;min-height:92px;padding:10px 12px;background:var(--inset);border:1px solid var(--edge);border-radius:6px;color:var(--tx);font-size:14px;line-height:1.5;resize:vertical}
  textarea:focus{outline:none;border-color:var(--acc)} textarea::placeholder{color:#7f93c4} textarea:disabled{opacity:.6}
  .chips{display:flex;flex-wrap:wrap;gap:6px} .chip{padding:3px 8px;border:1px solid var(--edge);border-radius:4px;font-size:12px;color:var(--tx2)} .chip.off{opacity:.45;text-decoration:line-through}
  .btn{height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 14px;border-radius:6px;font-size:14px;font-weight:500;cursor:pointer;border:1px solid var(--edge);background:var(--btn2);color:var(--tx)}
  .btn:hover{filter:brightness(1.15)} .btn:disabled{opacity:.45;cursor:default;filter:none}
  .btn.pri{height:46px;background:var(--acc);border-color:var(--acc);color:var(--ink);font-size:15px;font-weight:600}
  .btn.bad{background:none;border-color:var(--badbd);color:var(--bad)}
  .btn.sm{height:32px;padding:0 10px;font-size:12px}
  .btn.wide{justify-content:space-between;padding:0 16px}
  .btn .hint{font-size:12px;font-weight:500;opacity:.75}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .spread{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .g21{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:8px} .g11{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .item{display:flex;gap:10px;padding:10px 12px;background:var(--row);border:1px solid var(--line);border-radius:6px}
  .item.warnbox{background:var(--warnbg);border-color:var(--warnbd)} .item.cur{background:var(--inset);border-color:var(--acc)} .item.q{background:none}
  .item svg{flex:none;margin-top:1px} .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .stats{display:grid;border:1px solid var(--line);border-radius:6px} .stats>div{padding:10px 8px;border-right:1px solid var(--line);min-width:0} .stats>div:last-child{border-right:0}
  .stats .num{font-size:26px} .stats .lbl{margin-top:4px;letter-spacing:.06em}
  .big .num{font-size:34px}
  .bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden} .bar i{display:block;height:100%;background:var(--acc)}
  .cells{display:grid;gap:3px} .cells span{height:12px;border-radius:2px;background:var(--line)} .cells .d{background:var(--acc)} .cells .c{background:var(--cur);box-shadow:inset 0 0 0 1px var(--acc)}
  .cells.thin span{height:6px}
  ol.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:13px} ol.steps li{display:flex;gap:8px}
  .rec{display:flex;align-items:center;gap:10px;padding:8px;border-radius:6px} .rec.new{background:var(--row)}
  .recs{display:flex;flex-direction:column;padding:0 6px 10px} .recs-h{padding:14px 14px 6px}
  .linkrow{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:var(--row);border:0;border-bottom:1px solid var(--line);color:var(--tx2);font-size:13px;text-align:left;cursor:pointer}
  .linkrow:hover{filter:brightness(1.15)} .linkrow b{font-weight:600} .linkrow span{display:flex;align-items:center;gap:6px}
  .tools{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--line)}
  .tools button{height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:none;border:0;border-right:1px solid var(--line);color:var(--tx2);font-size:12px;cursor:pointer}
  .tools button:last-child{border-right:0} .tools button:hover{background:var(--row)} .tools button:disabled{opacity:.4;cursor:default;background:none}
  footer{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--foot);font-size:12px;color:var(--mut)}
  .dot{width:7px;height:7px;border-radius:4px;flex:none}
  label.ck{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--tx2);cursor:pointer} label.ck:has(input:disabled){cursor:default}
  input[type=checkbox]{appearance:none;-webkit-appearance:none;display:inline-grid;place-content:center;width:18px;height:18px;margin:0;flex:none;border:1.5px solid var(--edge);border-radius:4px;background:var(--inset);cursor:pointer;transition:background-color .12s,border-color .12s}
  input[type=checkbox]::after{content:'';width:4px;height:9px;margin-top:-2px;border:solid var(--ink);border-width:0 2.5px 2.5px 0;transform:rotate(45deg) scale(0);transition:transform .12s}
  input[type=checkbox]:hover{border-color:var(--sky)}
  input[type=checkbox]:checked{background:var(--acc);border-color:var(--acc)} input[type=checkbox]:checked::after{transform:rotate(45deg) scale(1)}
  input[type=checkbox]:focus-visible{outline:2px solid var(--sky);outline-offset:2px}
  input[type=checkbox]:disabled{cursor:default;opacity:.45} input[type=checkbox]:disabled:hover{border-color:var(--edge)}
  .fld{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;color:var(--tx2)}
  .fld input{width:140px;height:32px;padding:0 8px;background:var(--inset);border:1px solid var(--edge);border-radius:6px;color:var(--tx);font-size:13px}
  .fld input.s{width:72px} .fld .pair{display:flex;align-items:center;gap:6px}
  .fgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;padding:10px 12px;background:var(--row);border:1px solid var(--line);border-radius:6px} .fgrid label.ck{font-size:12px}
  .note{margin:10px 14px 0;padding:8px 10px;border:1px solid var(--edge);background:var(--row);border-radius:6px;font-size:12px;color:var(--tx2);display:flex;gap:8px;align-items:flex-start} .note span{flex:1}
  .note button{background:none;border:0;color:var(--mut);cursor:pointer;padding:0;font-size:14px;line-height:1}
  .okring{width:40px;height:40px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:20px;background:var(--okbg);color:var(--ok)}
  .spin{display:inline-flex;animation:tipsx-spin .9s linear infinite} @keyframes tipsx-spin{to{transform:rotate(360deg)}}
  .fab .ok{color:var(--ok)} .fab .lab{font-weight:500;color:var(--tx2);white-space:nowrap}
  code{font-size:11px;color:var(--sky);background:var(--row);border:1px solid var(--line);padding:0 4px;border-radius:3px}
  pre{white-space:pre-wrap;font-size:11px;max-height:120px;overflow:auto;background:var(--inset);padding:6px;border-radius:5px;color:var(--tx2);margin:6px 0 0}
  details summary{cursor:pointer}
  table{width:100%;border-collapse:collapse;font-size:12px} td,th{padding:4px;border-bottom:1px solid var(--line);text-align:left;color:var(--tx2)} th{color:var(--sky);font-weight:600}`;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function setMsg(m) { S.msg = m; render(); }

  // ---- position / dragging (position is remembered)
  function placeHost() {
    const pos = S.settings.pos;
    if (!pos) { host.style.left = host.style.top = ''; host.style.right = '16px'; host.style.bottom = '16px'; return; }
    const r = host.getBoundingClientRect();
    const w = r.width || 160, h = r.height || 40;
    const left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - w));
    const top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - Math.min(h, 60)));
    host.style.right = host.style.bottom = 'auto';
    host.style.left = left + 'px'; host.style.top = top + 'px';
  }
  // Returns true if the pointer actually moved (so a click on the FAB is not treated as a drag).
  function startDrag(ev, handle, onClick) {
    if (ev.button !== 0 || (ev.target.closest && ev.target.closest('button') && ev.target !== handle)) return;
    ev.preventDefault();
    const r = host.getBoundingClientRect();
    const dx = ev.clientX - r.left, dy = ev.clientY - r.top, sx = ev.clientX, sy = ev.clientY;
    let moved = false;
    handle.classList.add('dragging');
    const move = e => {
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
      moved = true;
      S.settings.pos = { left: e.clientX - dx, top: e.clientY - dy }; placeHost();
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
      handle.classList.remove('dragging');
      if (moved) saveSettings(); else if (onClick) onClick();
    };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
  }
  window.addEventListener('resize', () => placeHost());

  const svg = (d, w = 18, sw = 2) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    gear: svg('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>', 18, 1.8),
    min: svg('<path d="M5 12h14"></path>'),
    search: svg('<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>', 18, 2.2),
    dl: svg('<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path>', 18, 2.2),
    dlS: svg('<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path>', 16),
    up: svg('<path d="M12 21V9"></path><path d="M7 14l5-5 5 5"></path><path d="M5 3h14"></path>', 16),
    redo: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path>', 16),
    list: svg('<path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h10"></path>', 16),
    next: svg('<path d="M9 6l6 6-6 6"></path>', 16),
    back: svg('<path d="M15 6l-6 6 6 6"></path>', 16),
    arrow: svg('<path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path>', 18, 2.2),
    check: svg('<path d="M20 6L9 17l-5-5"></path>', 18, 2.4),
    checkBig: svg('<path d="M20 6L9 17l-5-5"></path>', 20, 2.6),
    x: svg('<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>', 16, 2.2),
    pause: svg('<path d="M9 5v14"></path><path d="M15 5v14"></path>', 16, 2.2),
    play: svg('<path d="M7 5l12 7-12 7z"></path>', 16, 2.2),
    warn: svg('<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>')
  };
  const fmtN = n => Number(n || 0).toLocaleString('en-US');
  const when = iso => {
    const d = new Date(iso), now = new Date(), t = d.toTimeString().slice(0, 5);
    if (d.toDateString() === now.toDateString()) return 'today ' + t;
    if (d.toDateString() === new Date(now - 864e5).toDateString()) return 'yesterday';
    return d.toISOString().slice(0, 10);
  };
  const runLabel = run => { const it = run.items[run.results.length]; const l = run.label.startsWith(it ? it.tips : '\0') ? run.label.slice(it.tips.length).replace(/^ – /, '') : run.label; return l || 'starting…'; };
  const stats4 = (a) => `<div class="stats" style="grid-template-columns:repeat(${a.length},minmax(0,1fr))">${a.map(([v, l]) => `<div><div class="num">${esc(v)}</div><div class="lbl">${esc(l)}</div></div>`).join('')}</div>`;
  const cells = (n, done, cur, thin) => `<div class="cells${thin ? ' thin' : ''}" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${Array.from({ length: n }, (_, k) => `<span class="${k < done ? 'd' : k === cur ? 'c' : ''}"></span>`).join('')}</div>`;

  // ---- single LI
  function vSingle() {
    const sg = S.single, run = S.run && S.run.kind === 'single' ? S.run : null;
    const blocked = !!(S.run || S.pending), F = S.settings.files;
    let h = '';
    if (run) h += vSingleRun(run);
    else if (sg && sg.phase === 'done') h += vSingleDone(sg);
    else {
      const looking = sg && sg.phase === 'looking';
      h += `<section>
        <label for="li" class="h">Download LI documents</label>
        <textarea id="li" rows="3" placeholder="LI42.10-P-078779&#10;078780, 061245 …" ${blocked || looking ? 'disabled' : ''}>${esc(liText)}</textarea>`;
      if (sg && sg.phase === 'looked') h += `</section>` + vLooked(sg);
      else h += `<div class="mut">Full numbers, or a unique ending such as 078779 once the index is built. Separate several with spaces, commas or new lines.</div>
        <div class="chips"><span class="chip">Current PDF</span><span class="chip">Every prior version</span><span class="chip">Attachments</span><span class="chip${F.histCsv || F.histJson ? '' : ' off'}">Revision history</span><span class="chip${F.attCsv ? '' : ' off'}">Links list</span></div>
        <button class="btn pri wide" id="look" ${blocked || looking ? 'disabled' : ''}><span class="row">${I.search}${looking ? 'Looking up…' : 'Look up'}</span><span class="hint">Ctrl+Enter</span></button>
        ${blocked ? '<div class="mut">A bulk batch is running or waiting for approval – finish or discard it first.</div>' : ''}
      </section>`;
    }
    if (!run) h += vRecent(sg);
    return h + vBulkRow();
  }
  function vLooked(sg) {
    const n = sg.found.length + sg.problems.length;
    return `<div class="recs-h spread"><span class="lbl">Found in TIPS</span><span class="mut">${sg.found.length} of ${n} entr${n === 1 ? 'y' : 'ies'}</span></div>
      <section style="padding-top:4px">
      ${sg.found.map(f => `<div class="item"><span class="ok">${I.check}</span><div class="body">
        <div class="spread"><span class="mono">${esc(f.tips)}</span><span class="mut">v${esc(f.version)} · ${Math.max(0, f.version - 1)} prior</span></div>
        <span class="tx2">${esc(f.title)}</span>${f.src ? `<span class="mut">from “${esc(f.src)}”</span>` : ''}</div></div>`).join('')}
      ${sg.problems.map(p => `<div class="item warnbox"><span class="warn">${I.warn}</span><div class="body">
        <span class="mono warn">${esc(p.token)}</span><span>${esc(p.text)}</span>
        ${p.matches ? `<span class="mono mut">${esc(p.matches.join(', '))}${p.count > 3 ? ' …' : ''}</span>` : ''}</div></div>`).join('')}
      <div class="g21"><button class="btn pri" id="dlfound" ${sg.found.length ? '' : 'disabled'}>${I.dl}Download ${sg.found.length || ''}</button><button class="btn" id="clear">Clear</button></div>
      ${sg.found.length ? `<div class="mono mut">→ ${esc(selectionName(sg.found))}</div>` : ''}
      </section>`;
  }
  function vSingleRun(run) {
    const doneN = run.results.length, st = run.step, gi = st ? ['data', 'pdf', 'att', 'prior'].indexOf(st.g) : -1;
    const frac = !st ? 0 : st.g === 'data' ? .1 : st.g === 'pdf' ? .2 : st.g === 'att' ? .2 + .3 * st.k / st.n : .5 + .5 * st.k / st.n;
    const pct = 100 * (doneN + frac) / run.total;
    let steps = '';
    if (st) {
      const L = [];
      L.push(gi <= 1 ? ['cur', st.g === 'data' ? 'Topic data' : `Current PDF v${st.v}`] : ['done', 'Topic data &amp; current PDF']);
      if (run.attN) L.push(gi === 2 ? ['cur', `Attachment ${st.k} of ${st.n}`] : gi > 2 ? ['done', `${run.attN} attachment${run.attN > 1 ? 's' : ''}`] : null);
      if (gi === 3) L.push(['cur', `Prior version v${st.k} of ${st.n}`]);
      steps = `<ol class="steps">${L.filter(Boolean).map(([k, t]) => k === 'done' ? `<li class="mut"><span class="ok">✓</span>${t}</li>` : `<li><span class="acc">›</span>${t}</li>`).join('')}</ol>`
        + (gi === 3 && st.n <= 40 ? cells(st.n, st.k - 1, st.k - 1, true) : '');
    }
    return `<section style="padding-top:18px">
        <div class="spread" style="align-items:flex-end"><div><div class="lbl">Document</div>
          <div class="num" style="font-size:52px">${Math.min(doneN + 1, run.total)}<span class="dim">/${run.total}</span></div></div>
          <div class="mut" style="text-align:right">saves to Downloads<br>when finished</div></div>
        <div class="bar"><i id="pbar" style="width:${pct.toFixed(1)}%"></i></div>
      </section>
      <section style="padding-top:12px;gap:8px">
      ${run.items.map((it, k) => {
        const r = run.results[k];
        if (r) return `<div class="item"><div class="body"><div class="spread"><span class="mono">${esc(it.tips)}</span>${r.status === 'ok' ? '<span class="ok">✓ done</span>' : '<span class="bad">failed</span>'}</div></div></div>`;
        if (k === doneN) return `<div class="item cur"><div class="body" style="gap:8px"><div class="spread"><span class="mono">${esc(it.tips)}</span><span class="acc" style="font-size:12px">in progress</span></div>
          ${steps || `<div class="mut" id="plabel">${esc(runLabel(run))}</div>`}</div></div>`;
        return `<div class="item q"><div class="spread" style="flex:1"><span class="mono mut">${esc(it.tips)}</span><span class="mut">queued</span></div></div>`;
      }).join('')}
      </section>
      <section><button class="btn bad" id="cancel">${I.x}Cancel download</button>
        <div class="mut">Cancelling saves nothing. Bulk export progress isn't affected either way.</div></section>`;
  }
  function vSingleDone(sg) {
    const m = sg.sum, np = sg.problems.length;
    return `<section style="padding-top:18px">
        <div class="row" style="flex-wrap:nowrap;gap:12px"><span class="okring">${I.checkBig}</span>
          <div class="body"><span class="h">Saved to Downloads</span><span class="mono mut" style="overflow-wrap:anywhere">${esc(sg.fname)}</span></div></div>
        ${stats4([[m.sizeMB, 'MB'], [`${m.ok}/${m.docs}`, 'Docs'], [m.att, 'Attach.'], [m.prev, 'Prior ver.']])}
        ${m.errors.length ? `<div class="item warnbox"><div class="body"><details><summary class="warn" style="font-weight:600">${m.errors.length} file${m.errors.length > 1 ? 's' : ''} could not be saved</summary><pre>${esc(m.errors.join('\n'))}</pre></details><span class="mut">Also listed in _errors.txt inside the zip.</span></div></div>` : ''}
        ${np ? `<div class="item warnbox"><div class="body"><span class="warn" style="font-weight:600">${np} entr${np > 1 ? 'ies' : 'y'} skipped</span>
          ${sg.problems.map(p => `<span><span class="mono">${esc(p.token)}</span> – ${esc(p.text)}</span>`).join('')}</div>
          <button class="btn sm" id="fix" style="align-self:center;border-color:var(--warnbd);color:var(--warn);background:none">Fix</button></div>` : ''}
        <button class="btn pri" id="newdl">New download</button>
      </section>`;
  }
  function vRecent(sg) {
    if (!S.recent.length) return '';
    const blocked = !!(S.run || S.pending);
    return `<div class="recs-h"><div class="lbl">Recent downloads</div></div><div class="recs">
      ${S.recent.slice(0, 5).map((r, k) => {
        const name = r.docs === 1 ? r.tips[0] : `${r.docs} documents`;
        const meta = (r.docs === 1 ? `v${r.v} · ` : `${r.tips.slice(0, 2).join(', ')}${r.docs > 2 ? ' …' : ''} · `) + `${r.sizeMB} MB · ${when(r.date)}`;
        return `<div class="rec${k === 0 && sg && sg.phase === 'done' && sg.fname === r.fname ? ' new' : ''}"><div class="body"><span class="mono">${esc(name)}</span><span class="mut">${esc(meta)}</span></div>
          <button class="ib" data-redo="${k}" aria-label="Download ${esc(name)} again" title="Look up again" style="border:1px solid var(--edge)" ${blocked ? 'disabled' : ''}>${I.redo}</button></div>`;
      }).join('')}</div>`;
  }
  function vBulkRow() {
    const run = S.run && S.run.kind === 'bulk' ? S.run : null, nb = nextBatch();
    const right = run ? `<span class="acc">${esc(run.title)} · ${run.i}/${run.total}</span>` : S.pending ? '<span class="ok">Batch ready for review</span>'
      : S.index.length ? `${fmtN(doneCount())} / ${fmtN(S.index.length)}${nb ? ` · batch ${nb} next` : ' · all done'}` : 'no index yet';
    return `<button class="linkrow" id="tobulk"><b>Bulk export</b><span class="mut">${right}${I.next}</span></button>`;
  }

  // ---- bulk
  function vBulk() {
    const s = S.settings, run = S.run && S.run.kind === 'bulk' ? S.run : null, pen = S.pending, dc = doneCount(), nb = nextBatch(), pendN = pendingItems().length;
    const busy = !!S.run, pct = S.index.length ? 100 * dc / S.index.length : 0;
    let h = `<button class="linkrow" id="tosingle"><span>${I.back}<b>Single LI</b></span><span class="mut">download specific documents</span></button>
      <div class="stats big" style="grid-template-columns:repeat(3,minmax(0,1fr));border:0;border-bottom:1px solid var(--line);border-radius:0">
        <div style="padding:14px"><div class="num">${fmtN(dc)}</div><div class="lbl">Exported</div></div>
        <div style="padding:14px"><div class="num">${fmtN(pendN)}</div><div class="lbl">Pending</div></div>
        <div style="padding:14px"><div class="num acc">${nb ?? (S.index.length ? '✓' : '—')}</div><div class="lbl">Next batch</div></div></div>
      <section style="gap:6px"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="spread mut"><span>${pct.toFixed(1)}% of ${fmtN(S.index.length)} topics</span><span>~${remainingBatches()} batches left · ${s.batchSize} each</span></div></section>`;
    if (run) h += `<section style="padding-top:16px">
        <div class="spread" style="align-items:flex-end"><div><div class="lbl">${esc(run.title)}${run.paused ? ' <span class="warn">· paused</span>' : ''}</div>
          <div class="num" style="font-size:52px">${run.i}<span class="dim">/${run.total}</span></div></div><div class="mut" style="text-align:right">documents<br>in this batch</div></div>
        ${run.total <= 60 ? cells(run.total, run.i - 1, run.i - 1) : `<div class="bar"><i id="pbar" style="width:${(100 * (run.i - 1) / run.total).toFixed(1)}%"></i></div>`}
        <div class="item cur"><div class="body"><span class="mono">${esc((run.items[run.results.length] || {}).tips || '')}</span><span class="mut" id="plabel">${esc(runLabel(run))}</span></div></div>
        <div class="g11"><button class="btn" id="pause">${run.paused ? I.play + 'Resume' : I.pause + 'Pause'}</button><button class="btn bad" id="cancel">${I.x}Cancel</button></div>
        <div class="mut">Nothing downloads until you approve the batch. Cancel discards it; its documents stay pending.</div></section>`;
    else if (pen) { const m = pen.summary; h += `<section style="padding-top:16px">
        <div><div class="lbl">Batch ${pen.n} ready</div><div class="mono" style="font-size:14px;margin-top:4px">${esc(m.fname)}</div></div>
        ${stats4([[m.sizeMB, 'MB'], [`${m.ok}/${m.docs}`, 'Docs'], [m.att, 'Attach.'], [m.prev, 'Prior ver.']])}
        <div class="mono mut">${esc(m.range)}</div>
        ${m.errors.length ? `<div class="item warnbox"><div class="body"><details><summary class="warn" style="font-weight:600">${m.errors.length} error${m.errors.length > 1 ? 's' : ''}</summary><pre>${esc(m.errors.join('\n'))}</pre></details></div></div>` : '<div class="ok" style="font-size:12px">No errors</div>'}
        <div class="g21"><button class="btn pri" id="approve">${I.check}Approve &amp; download</button><button class="btn" id="discard">Discard</button></div></section>`; }
    else h += `<section><button class="btn pri wide" id="prep" ${!S.index.length || !nb ? 'disabled' : ''}><span>${nb ? `Prepare batch ${nb}` : S.index.length ? 'Everything exported' : 'Build the index first'}</span><span class="row" style="font-weight:500">${nb ? `${Math.min(s.batchSize, pendN)} docs ${I.arrow}` : ''}</span></button></section>`;
    h += `<section style="flex-direction:row;gap:16px;flex-wrap:wrap">
        <label class="ck"><input type="checkbox" id="autoc" ${s.autoContinue ? 'checked' : ''}> Auto-continue</label>
        <label class="ck"><input type="checkbox" id="autoa" ${s.autoApprove ? 'checked' : ''}> Auto-approve</label></section>
      <div class="tools">
        <button id="refresh" ${!S.index.length || busy ? 'disabled' : ''}>${I.redo}Check new</button>
        <button id="build" ${busy ? 'disabled' : ''}>${I.list}${S.index.length ? 'Rebuild' : 'Build index'}</button>
        <button id="imp" ${busy ? 'disabled' : ''}>${I.up}Import log</button>
        <button id="exp" ${!S.index.length ? 'disabled' : ''}>${I.dlS}Save log</button>
      </div><input type="file" id="file" accept=".csv" style="display:none">`;
    if (S.history.length) h += `<section><details><summary class="lbl">Batch history (${S.history.length} in this browser)</summary>
        <table><tr><th>#</th><th>Size</th><th>Docs</th><th>Att.</th><th>Prev.</th><th>Err.</th></tr>
        ${S.history.slice().reverse().map(x => `<tr><td>${x.n}</td><td>${x.sizeMB} MB</td><td>${x.ok}/${x.docs}</td><td>${x.att}</td><td>${x.prev}</td><td>${x.errors}</td></tr>`).join('')}</table></details></section>`;
    return h;
  }

  // ---- settings
  function vSettings() {
    const s = S.settings;
    return `<section>
      <div class="lbl">Settings</div>
      <label class="fld">Batch size <input class="s" type="number" id="s_bs" value="${s.batchSize}" min="1" max="500"></label>
      <label class="fld">Delay between docs (ms) <span class="pair"><input class="s" type="number" id="s_delay" value="${s.delayMs}" min="0" step="250" aria-label="Minimum delay"> to <input class="s" type="number" id="s_delay2" value="${s.delayMaxMs}" min="0" step="250" aria-label="Maximum delay"></span></label>
      <label class="fld">Search page size <span class="pair"><span class="mut">${s.pageSizeSrc === 'detected' ? '<span class="ok">✓</span> matches Reader' : s.pageSizeSrc === 'manual' ? 'set manually' : '<span class="warn">not detected</span>'}</span><input class="s" type="number" id="s_ps" value="${s.pageSize}" min="1" max="500"></span></label>
      <label class="fld">Outlet <input type="text" id="s_outlet" value="${esc(s.outlet)}"></label>
      <label class="fld">User <input type="text" id="s_user" value="${esc(s.user)}"></label>
      <label class="fld">Reader version <input type="text" id="s_ver" value="${esc(s.ver)}"></label>
      <div class="lbl" style="margin-top:4px">Data files to include <span class="mut" style="text-transform:none;letter-spacing:0;font-weight:400">– PDFs and attachments are always saved</span></div>
      <div class="fgrid">
        <label class="ck"><input type="checkbox" id="f_docJson" ${s.files.docJson ? 'checked' : ''}> Document data <code>.json</code></label>
        <label class="ck"><input type="checkbox" id="f_histCsv" ${s.files.histCsv ? 'checked' : ''}> Revision history <code>.csv</code></label>
        <label class="ck"><input type="checkbox" id="f_histJson" ${s.files.histJson ? 'checked' : ''}> Revision history <code>.json</code></label>
        <label class="ck"><input type="checkbox" id="f_attCsv" ${s.files.attCsv ? 'checked' : ''}> Links list <code>.csv</code></label>
        <label class="ck"><input type="checkbox" id="f_manifest" ${s.files.manifest ? 'checked' : ''}> Manifest <code>.csv</code></label>
        <label class="ck" title="Always included – needed to resume"><input type="checkbox" checked disabled> Progress log <code>.csv</code></label>
      </div>
      <div class="row"><button class="btn sm" id="f_all">All</button><button class="btn sm" id="f_csv">CSV only</button><button class="btn sm" id="f_json">JSON only</button><button class="btn sm" id="f_none">None</button></div>
      ${!s.files.attCsv ? '<div class="mut warn">Links to other LIs are only recorded in the attachments &amp; links CSV.</div>' : ''}
      <div class="row"><button class="btn sm" id="s_save" style="background:var(--acc);border-color:var(--acc);color:var(--ink);font-weight:600">Save</button><button class="btn sm" id="s_detect">Re-detect session</button><button class="btn sm" id="s_pos">Reset panel position</button></div>
    </section>`;
  }

  function render() {
    if (!visible) {
      const run = S.run && S.run.kind === 'single' ? S.run : null, flash = fabFlash && Date.now() < fabFlash.until ? fabFlash : null;
      const cur = run && run.items[run.results.length];
      const inner = run ? `<span class="spin acc">${svg('<path d="M12 3a9 9 0 1 0 9 9"></path>', 16, 2.4)}</span>${cur ? esc(cur.tips) + ' · ' : ''}<span class="lab" id="plabel">${esc(runLabel(run))}</span>`
        : flash ? `<span class="ok">${svg('<path d="M20 6L9 17l-5-5"></path>', 16, 2.6)}</span><span class="lab">${esc(flash.text)}</span>`
        : '<span class="mark"></span>TIPS EXPORTER';
      root.innerHTML = `<style>${css}</style><div class="fab" id="open" title="Click to open · drag to move">${inner}</div>`;
      const fab = root.getElementById('open');
      fab.onpointerdown = e => startDrag(e, fab, () => { visible = true; render(); });
      placeHost(); syncToolbar(); return;
    }
    // keep typing focus across re-renders
    const ae = root.activeElement, focusLi = ae && ae.id === 'li', selA = focusLi ? ae.selectionStart : 0, selB = focusLi ? ae.selectionEnd : 0;
    const s = S.settings, run = S.run;
    const status = run ? (run.kind === 'single' ? '<span class="acc">● Downloading</span>' : run.paused ? `<span class="warn">● ${esc(run.title)} paused</span>` : `<span class="acc">● ${esc(run.title)} running</span>`)
      : S.pending ? '<span class="ok">● Awaiting approval</span>' : view === 'single' && S.single && S.single.phase === 'done' ? '<span class="ok">● Saved</span>' : '';
    root.innerHTML = `<style>${css}</style><div class="panel">
      <header id="hdr" title="Drag to move · double-click to reset position">
        <div class="brand"><span class="mark"></span><b>TIPS EXPORTER</b><span class="status">${status}</span></div>
        <div class="row" style="gap:0;flex-wrap:nowrap"><button class="ib" id="gear" aria-label="Settings" aria-pressed="${showSettings}">${I.gear}</button><button class="ib" id="min" aria-label="Minimise panel">${I.min}</button></div>
      </header>
      ${S.msg ? `<div class="note" role="status"><span>${esc(S.msg)}</span><button id="msgx" aria-label="Dismiss message">×</button></div>` : ''}
      ${showSettings ? vSettings() : ''}
      ${view === 'bulk' ? vBulk() : vSingle()}
      <footer>${sessionOK() ? `<span class="dot" style="background:var(--ok)"></span><span>Session OK · ${esc(s.user)} · outlet ${esc(s.outlet)} · Reader v${esc(s.ver)}</span>`
        : '<span class="dot" style="background:var(--warn)"></span><span>Session not detected – open any topic once, or set it in ⚙</span>'}</footer>
    </div>`;
    const $ = id => root.getElementById(id);
    const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
    const safeRun = fn => async () => { try { await fn(); } catch (e) { S.run = null; setMsg((e instanceof SessionError ? '⚠ ' : 'Error: ') + e.message); } };
    const focusBox = () => { const t = $('li'); if (t) { t.focus(); t.selectionStart = t.selectionEnd = t.value.length; } };
    const hdr = $('hdr');
    hdr.onpointerdown = e => startDrag(e, hdr);
    hdr.ondblclick = e => { if (!e.target.closest('button')) { S.settings.pos = null; saveSettings(); placeHost(); } };
    on('min', 'onclick', () => { visible = false; render(); });
    on('gear', 'onclick', () => { showSettings = !showSettings; render(); });
    on('msgx', 'onclick', () => { S.msg = ''; render(); });

    // single LI
    const lookup = safeRun(() => lookupSpecific(liText));
    const dlFound = safeRun(downloadFound);
    on('li', 'oninput', e => { liText = e.target.value; if (S.single && S.single.phase === 'looked') { S.single = null; render(); } });
    on('li', 'onkeydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); lookup(); } });
    on('look', 'onclick', lookup);
    on('dlfound', 'onclick', dlFound);
    on('clear', 'onclick', () => { liText = ''; S.single = null; render(); focusBox(); });
    on('newdl', 'onclick', () => { liText = ''; S.single = null; render(); focusBox(); });
    on('fix', 'onclick', () => { liText = S.single.problems.map(p => p.token).join('\n'); S.single = null; render(); focusBox(); });
    root.querySelectorAll('[data-redo]').forEach(b => b.onclick = () => { const r = S.recent[+b.dataset.redo]; if (!r) return; liText = r.tips.join('\n'); S.single = null; lookup(); });
    on('tobulk', 'onclick', () => { view = 'bulk'; render(); });
    on('tosingle', 'onclick', () => { view = 'single'; render(); });

    // run controls (both views)
    on('pause', 'onclick', () => { S.run.paused = !S.run.paused; render(); });
    on('cancel', 'onclick', () => { S.run.cancel = true; S.run.paused = false; });

    // bulk
    on('approve', 'onclick', safeRun(approve));
    on('discard', 'onclick', discard);
    on('prep', 'onclick', safeRun(prepareBatch));
    on('autoc', 'onchange', async e => { s.autoContinue = e.target.checked; await saveSettings(); });
    on('autoa', 'onchange', async e => {
      if (e.target.checked && !confirm('Auto-approve downloads every batch without asking. Continue?')) { e.target.checked = false; return; }
      s.autoApprove = e.target.checked; await saveSettings();
    });
    on('build', 'onclick', safeRun(buildIndex));
    on('refresh', 'onclick', safeRun(refreshIndex));
    on('imp', 'onclick', () => $('file').click());
    on('file', 'onchange', safeRun(async () => { const f = $('file').files[0]; if (f) await importLog(await f.text()); }));
    on('exp', 'onclick', () => saveBlob(new Blob([progressCsv()], { type: 'text/csv' }), `TIPS_progress_log_${new Date().toISOString().slice(0, 10)}.csv`));

    // settings
    on('s_save', 'onclick', async () => {
      const bs = Math.round(+$('s_bs').value);
      if (!(bs >= 1 && bs <= 500)) { setMsg('Batch size must be 1–500.'); return; }
      const ps = Math.round(+$('s_ps').value);
      if (!(ps >= 1 && ps <= 500)) { setMsg('Search page size must be 1–500.'); return; }
      if (ps !== s.pageSize) { s.pageSize = ps; s.pageSizeSrc = 'manual'; }
      const d1 = Math.max(0, +$('s_delay').value || 0), d2 = Math.max(0, +$('s_delay2').value || 0);
      s.delayMs = Math.min(d1, d2); s.delayMaxMs = Math.max(d1, d2);
      s.batchSize = bs;
      s.outlet = $('s_outlet').value.trim(); s.user = $('s_user').value.trim(); s.ver = $('s_ver').value.trim();
      readFileBoxes();
      await saveSettings(); setMsg(`Settings saved. Batch size is now ${bs}.`);
    });
    const FK = ['docJson', 'histCsv', 'histJson', 'attCsv', 'manifest'];
    const readFileBoxes = () => { for (const k of FK) if ($('f_' + k)) s.files[k] = $('f_' + k).checked; };
    for (const k of FK) on('f_' + k, 'onchange', async () => { readFileBoxes(); await saveSettings(); render(); });
    const preset = async p => { Object.assign(s.files, p); await saveSettings(); setMsg('File selection saved.'); };
    on('f_all', 'onclick', () => preset({ docJson: true, histCsv: true, histJson: true, attCsv: true, manifest: true }));
    on('f_csv', 'onclick', () => preset({ docJson: false, histCsv: true, histJson: false, attCsv: true, manifest: true }));
    on('f_json', 'onclick', () => preset({ docJson: true, histCsv: false, histJson: true, attCsv: false, manifest: false }));
    on('f_none', 'onclick', () => preset({ docJson: false, histCsv: false, histJson: false, attCsv: false, manifest: false }));
    on('s_detect', 'onclick', async () => {
      detectSession(); await detectUserFallback();
      if (s.pageSizeSrc === 'manual') s.pageSizeSrc = 'default';
      notePageSize(+document.documentElement.dataset.tipsxPageSize);
      await saveSettings(); render();
    });
    on('s_pos', 'onclick', async () => { s.pos = null; await saveSettings(); placeHost(); });

    if (focusLi && $('li') && !$('li').disabled) { $('li').focus(); $('li').setSelectionRange(selA, selB); }
    placeHost(); syncToolbar();
  }
  function renderProgress() {
    const bar = root.getElementById('pbar'), lab = root.getElementById('plabel');
    if (bar && S.run && S.run.kind === 'bulk') bar.style.width = (100 * (S.run.i - 1) / S.run.total).toFixed(1) + '%';
    if (lab && S.run) lab.textContent = runLabel(S.run);
  }

  // ---------------------------------------------------------------- TIPS topic toolbar: "download this topic" button
  // Sits after the Reader's Print button in the open topic dialog (neo-topic-detail). The open topic comes from the
  // route (/search/topics/<topicId>/<version>); the LI number from the index, else from the dialog text.
  // If the Reader changes its markup the button simply doesn't appear; the panel keeps working.
  const ROUTE_RE = /\/search\/topics\/(\d+)\/(\d+)/, LI_RE = /(?<![A-Z0-9])[A-Z]{2}\d{2}\.\d{2}-[A-Z]-\d{6}(?!\d)/;
  const tb = { state: 'idle', msg: '' };   // idle | busy | done | error
  const PAGE_CSS = `
  .tipsx-dlwrap{position:relative;display:inline-flex;align-items:center}
  .tipsx-dl{position:relative;display:inline-flex;align-items:center;justify-content:center;margin:0;padding:0;border:0;border-radius:2px;background:transparent;color:var(--tipsx-fg,#222);cursor:pointer}
  .tipsx-dl:hover,.tipsx-dl:focus-visible{background:#e8f1fd;color:#1f6fd1;outline:none}
  .tipsx-dl[data-state=busy]{color:#1f6fd1;cursor:progress} .tipsx-dl[data-state=done]{color:#1d7a4a} .tipsx-dl[data-state=error]{color:#b3261e}
  .tipsx-dot{position:absolute;right:5px;top:5px;width:6px;height:6px;border-radius:2px;background:#2e8ff0}
  .tipsx-spin{animation:tipsx-spin .9s linear infinite;transform-origin:50% 50%} @keyframes tipsx-spin{to{transform:rotate(360deg)}}
  .tipsx-tip{position:absolute;top:calc(100% + 6px);right:0;z-index:100000;width:max-content;max-width:280px;padding:8px 10px;background:#222;color:#fff;font:12px/1.4 "Segoe UI",Arial,sans-serif;text-align:left;white-space:normal;pointer-events:none;opacity:0;transition:opacity .12s .2s}
  .tipsx-dlwrap:hover .tipsx-tip,.tipsx-dl:focus-visible+.tipsx-tip,.tipsx-dlwrap[data-show] .tipsx-tip{opacity:1}
  .tipsx-tip small{display:block;margin-top:2px;color:#bbb;font-size:11px}`;
  const pageSvg = (d, n) => `<svg width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const TB_ICON = {
    idle: '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path>',
    busy: '<circle cx="12" cy="12" r="8" stroke-opacity=".25"></circle><path class="tipsx-spin" d="M12 4a8 8 0 0 1 8 8"></path>',
    done: '<path d="M20 6L9 17l-5-5"></path>',
    error: '<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>'
  };

  function openTopic() {
    const m = location.pathname.match(ROUTE_RE); if (!m) return null;
    const tipsId = m[1], version = +m[2];
    const ix = S.index.find(x => String(x.tipsId) === tipsId);
    const det = document.querySelector('neo-topic-detail'), h2 = det && det.querySelector('h2');
    let tips = ix && ix.tips;
    if (!tips && det) {   // the Title tab's "Topic number" row, else the first LI-shaped number in the dialog
      const lab = [...det.querySelectorAll('td, th, span, div, p')].find(el => el.childElementCount === 0 && el.textContent.trim() === 'Topic number');
      const row = lab && (lab.nextElementSibling || lab.parentElement.nextElementSibling);
      tips = ((row && row.textContent.match(LI_RE)) || det.textContent.match(LI_RE) || [])[0];
    }
    return tips ? { tips, tipsId: ix ? ix.tipsId : tipsId, version, title: ix ? ix.title : (h2 ? h2.textContent.trim() : '') } : null;
  }
  function tipHtml() {
    if (tb.state === 'busy') return `Downloading${S.run && S.run.kind === 'single' ? ' – ' + esc(runLabel(S.run)) : '…'}<small>TIPS Exporter</small>`;
    if (tb.state !== 'idle') return `${esc(tb.msg)}<small>TIPS Exporter</small>`;
    const t = openTopic();
    if (!t) return 'Download this topic with all versions<small>TIPS Exporter</small>';
    const prior = Math.max(0, t.version - 1);
    return `Download ${esc(t.tips)} with ${prior ? `all ${prior} prior version${prior > 1 ? 's' : ''}, ` : ''}attachments and links<small>TIPS Exporter</small>`;
  }
  function syncToolbar() {
    for (const b of document.querySelectorAll('button.tipsx-dl')) {
      if (b.dataset.state !== tb.state) {
        b.dataset.state = tb.state;
        b.innerHTML = pageSvg(TB_ICON[tb.state], +b.dataset.icon || 22) + '<span class="tipsx-dot"></span>';
        b.setAttribute('aria-busy', String(tb.state === 'busy'));
        if (tb.state === 'done' || tb.state === 'error') b.parentElement.setAttribute('data-show', ''); else b.parentElement.removeAttribute('data-show');
      }
      const tip = b.nextElementSibling, html = tipHtml();
      if (tip && tip.innerHTML !== html) tip.innerHTML = html;
    }
  }
  async function downloadOpenTopic() {
    if (tb.state === 'busy') return;
    const settle = (state, msg, ms) => { tb.state = state; tb.msg = msg; syncToolbar(); setTimeout(() => { if (tb.state === state) { tb.state = 'idle'; syncToolbar(); } }, ms); };
    const t = openTopic();
    if (!t) return settle('error', "Couldn't tell which topic is open – use the panel instead.", 6000);
    if (S.run || S.pending) return settle('error', 'A bulk batch is running or waiting for approval – finish or discard it first.', 6000);
    if (!sessionOK()) return settle('error', 'Session not detected – open the panel and check ⚙ Settings.', 6000);
    tb.state = 'busy'; tb.msg = ''; view = 'single'; liText = t.tips; syncToolbar();
    try {
      const hit = await searchByNumber(t.tips.toUpperCase());   // current version, live from TIPS
      S.single = { phase: 'looked', found: [hit || t], problems: [] };
      await downloadFound();
      if (S.single && S.single.phase === 'done') {
        const m = S.single.sum;
        settle('done', `Saved ${S.single.fname} (${m.sizeMB} MB)${m.errors.length ? ` – ${m.errors.length} file(s) could not be saved, see the panel` : ''}`, 5000);
        fabFlash = { text: `Saved ${S.single.fname}`, until: Date.now() + 6000 }; setTimeout(render, 6100);
      } else settle('error', S.msg || 'Download stopped – nothing saved.', 6000);
    } catch (e) { settle('error', e.message, 6000); }
    render();
  }
  function injectToolbar() {
    injectQueued = false;
    if (!document.getElementById('tipsx-page-css')) {
      const st = document.createElement('style'); st.id = 'tipsx-page-css'; st.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    for (const print of document.querySelectorAll('neo-topic-detail button.xy-i-print')) {
      const anchor = print.closest('xy-c-spinner') || print.parentElement;
      if (!anchor || !anchor.parentElement || anchor.parentElement.querySelector(':scope > .tipsx-dlwrap')) continue;
      const r = print.getBoundingClientRect(), w = Math.round(r.width) || 40, h = Math.round(r.height) || w;
      const wrap = document.createElement('div'); wrap.className = 'tipsx-dlwrap';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tipsx-dl'; b.style.width = w + 'px'; b.style.height = h + 'px';
      b.dataset.icon = Math.round(Math.min(w, h) * .6);
      b.setAttribute('aria-label', 'Download this topic with all versions (TIPS Exporter)');
      b.style.setProperty('--tipsx-fg', getComputedStyle(print).color);
      const tip = document.createElement('div'); tip.className = 'tipsx-tip'; tip.setAttribute('role', 'tooltip');
      wrap.append(b, tip);
      anchor.after(wrap);
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); downloadOpenTopic(); });
      wrap.addEventListener('mouseenter', syncToolbar);
    }
    syncToolbar();
  }
  let injectQueued = false;
  new MutationObserver(muts => {
    if (injectQueued || muts.every(m => m.target.closest && m.target.closest('.tipsx-dlwrap'))) return;   // ignore our own button updates
    injectQueued = true; requestAnimationFrame(injectToolbar);
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('beforeunload', e => { if (S.run || S.pending) { e.preventDefault(); e.returnValue = ''; } });
  if (hasChrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((m, _s, reply) => { if (m && m.type === 'toggle') { visible = !visible; render(); } reply && reply(true); });
  }

  if (!hasChrome) window.__TIPSX_DEBUG = { S, importLog, prepareBatch, approve, discard, render, progressCsv, nextBatch, lookupSpecific, downloadFound, downloadOpenTopic };

  document.documentElement.appendChild(host);
  load().then(async () => { if (!S.settings.user) await detectUserFallback(); await saveSettings(); render(); });
  // Late detection: the Reader fires its first API calls after load
  setTimeout(() => { if (!sessionOK()) { detectSession(); saveSettings(); render(); } }, 5000);
})();
