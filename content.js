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
    resume: null,       // a download interrupted by a lost session: {title, kind, remaining, carry, finish}
    latest: {},         // newest versions seen by "Check for updates": tips -> version
    settings: { outlet: '', user: '', ver: '', batchSize: 25, delayMs: 2000, delayMaxMs: 5000, pageSize: 50, pageSizeSrc: 'default',
      autoApprove: false, autoContinue: true,
      files: { docJson: true, attCsv: true, histCsv: true, histJson: true, manifest: true } },
    run: null,          // {n, i, total, label, paused, cancel}
    pending: null,      // prepared batch awaiting approval {n, blob, fname, summary, results}
    msg: ''
  };
  const DEFAULT_SEARCH = { fuzzyActive: true, correlationId: 4, fallbackLang: 'en', area: 'WS', creator: null, sortorder: { field: 'mdate', order: 'desc' }, lang: { lang: 'en' }, countries: ['US'], vehicleContext: {}, timefilter: {}, docName: '', workstate: '', brandNames: ['Maybach', 'Mercedes-Benz'], productGroupNames: ['PKW', 'Supersportwagen'], pagination: { pageNumber: 1, pageSize: 50 }, drilldowns: [{ key: 'country', identifier: 'US' }], favFilterActive: false, searchField: 'all', provideNavigation: 'full', totalHitsCountOnly: false, useAi: false };

  let loaded = false;   // settings read from storage; nothing may be saved before this
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
    delete S.settings.pos;   // left over from the floating panel (≤1.5)
    loaded = true;
    if (hasChrome && (await store.get('openOnLoad', 0)) > Date.now() - 60000) { await store.set('openOnLoad', 0); setTimeout(() => openDrawer(true), 300); }   // toolbar icon reloaded this tab
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
    if (e.source !== window || !e.data || e.data.__tipsx !== 'pageSize' || !loaded) return;   // before load(), load() reads the probe's value itself
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
  // keep folder/file names short enough that extracted paths stay under Windows' 260-character limit
  const clip = (s, n) => { s = String(s || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, ''); if (s.length <= n) return s; const m = s.match(/^(.*?)(\.[A-Za-z0-9]{1,5})$/);
    return (m && m[2].length < n ? m[1].slice(0, n - m[2].length).replace(/[. ]+$/, '') + m[2] : s.slice(0, n).replace(/[. ]+$/, '')); };
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
  async function searchPass(order, m, label) {
    const size = S.settings.pageSize; let total = 0, hits = 0, changed = 0, done = false;
    for (let p = 1; p <= 2000; p++) {
      setMsg(`${label}… page ${p}${total ? ' of ' + Math.ceil(total / size) : ''}`);
      const r = await fetch('/tips/topic-service/api/v1/topics/search?' + Q(), { method: 'POST', credentials: 'include', headers: H(), body: JSON.stringify({ ...DEFAULT_SEARCH, sortorder: { field: 'mdate', order }, pagination: { pageNumber: p, pageSize: size } }) });
      if (r.status === 401 || r.status === 403) throw new SessionError('Session expired (HTTP ' + r.status + ')');
      if (!r.ok) { if (p === 1) throw new Error('Search failed: HTTP ' + r.status); break; }   // past a paging limit: keep what we have
      const j = await r.json(); total = j.totalHits;
      if (!j.hits || !j.hits.length) break;
      hits += j.hits.length;
      for (const h of j.hits) {
        const x = { tips: h.tips, tipsId: h.tipsId, version: h.version, title: h.title, mdate: h.modificationDate }, old = m.get(h.tipsId);
        if (old && old.version !== x.version) changed++;   // edited while we were paging: pages may have shifted
        if (!old || (x.mdate || 0) >= (old.mdate || 0)) m.set(h.tipsId, x);
      }
      if (hits >= total) { done = true; break; }
      await sleep(300);
    }
    return { total, done, changed };
  }
  async function fetchAllTopics() {
    const m = new Map();
    const a = await searchPass('asc', m, 'Searching TIPS');
    // Normally one pass. Only if it couldn't reach the end (TIPS stopped returning pages) search again from the newest end.
    const b = a.done ? null : await searchPass('desc', m, 'Searching TIPS from the newest end');
    const changed = a.changed + (b ? b.changed : 0);
    let short = '';
    if (!a.done && m.size < a.total) short += ` ⚠ TIPS reported ${a.total} hits but only ${m.size} topics could be read – TIPS may limit how far a search can be paged.`;
    if (changed) short += ` ${changed} topic(s) changed during the search – run "Check new" to make sure none were skipped.`;
    return { list: [...m.values()], total: a.total, short };
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
  // item.opts (from the row picker): {versions: [n…], att: bool, doc} – only those versions, attachments optional,
  // and the topic data it already read. Without opts: the current version, every prior version and all attachments.
  async function exportDoc(item, files, errors, step) {
    const base = `${safe(item.tips)} - ${clip(item.title, 45)}`, o = item.opts || null;
    step('topic data', { g: 'data' });
    let doc = o && o.doc;
    if (!doc) {
      const jr = await get(`/tips/topic-service/api/v1/topics/${item.tipsId}/${item.version}?${Q()}`, 'application/json');
      if (!jr.ok) throw new Error('topic data HTTP ' + jr.status);
      doc = await jr.json();
    }
    const v = doc.version || item.version, want = n => !o || o.versions.includes(n);
    const F = S.settings.files;
    if (F.docJson) files.push({ name: `${base}/${safe(item.tips)}_v${v}.json`, data: txt(JSON.stringify(doc, null, 2)) });

    if (want(v)) {
      step(`PDF v${v}`, { g: 'pdf', v });
      const pr = await get(`/tips/topic-service/api/v1/file/topics/${item.tipsId}/${v}?${Q()}`, 'application/pdf');
      if (pr.ok) files.push({ name: `${base}/${safe(item.tips)}_v${v}.pdf`, data: new Uint8Array(await pr.arrayBuffer()) });
      else errors.push(`${item.tips}: current PDF HTTP ${pr.status}`);
    }

    const atts = doc.attachments || [], refs = doc.references || [];
    let nAtt = 0;
    if ((atts.length || refs.length) && (!o || o.att)) {
      const dir = `${base}/Attachments and Links`;
      const lines = ['type,filename_or_target,description,created'];
      const used = new Set();
      for (const [k, a] of atts.entries()) {
        let fn = clip(a.filename || ('attachment_' + a.attId), 60); while (used.has(fn.toLowerCase())) fn = '_' + fn; used.add(fn.toLowerCase());
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
    const priors = []; for (let pv = 1; pv < v; pv++) if (want(pv)) priors.push(pv);
    for (const [k, pv] of priors.entries()) {
      step(`prior version v${pv}`, { g: 'prior', k: k + 1, n: priors.length, v: pv });
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
  // Exports `items` one by one with pause/cancel support. Returns {files, errors, results, leftover} or null if stopped.
  // A zip is held in memory until it is saved, so it stops at MAX_ZIP_MB; the rest comes back as `leftover`.
  // If the session is lost, the finished documents are kept in S.resume and the run can continue after logging in.
  const MAX_ZIP_MB = 400, capMB = () => +S.settings.maxZipMB || MAX_ZIP_MB;   // maxZipMB: hidden override (tests)
  async function runDocs(title, items, kind = 'bulk', exporter = exportDoc, carry = null) {
    const files = carry ? carry.files : [], errors = carry ? carry.errors : [], results = carry ? carry.results : [], all = carry ? carry.all : items;
    let bytes = files.reduce((a, f) => a + f.data.length, 0), cur = 0, leftover = [];
    S.run = { title, kind, items: all, results, i: results.length, total: all.length, label: '', step: null, attN: 0, paused: false, cancel: false };
    render();
    try {
      for (const [k, it] of items.entries()) {
        cur = k;
        if (bytes >= capMB() * 1048576) { leftover = items.slice(k); break; }
        if (k || carry) {
          const until = Date.now() + randDelay();
          while (Date.now() < until && !S.run.cancel) {
            S.run.step = null; S.run.attN = 0;
            S.run.label = `waiting ${Math.ceil((until - Date.now()) / 1000)} s before next document`; renderProgress();
            await sleep(Math.min(250, until - Date.now()));
          }
        }
        while (S.run.paused && !S.run.cancel) await sleep(400);
        if (S.run.cancel) throw new Error('cancelled');
        S.run.i++; S.run.label = it.tips; S.run.step = null; S.run.attN = 0; S.run.curPdf = false; render();
        const fMark = files.length, eMark = errors.length;
        try {
          const r = await exporter(it, files, errors, (s, info) => {
            S.run.label = `${it.tips} – ${s}`; S.run.step = info || null;
            if (info && info.g === 'att') S.run.attN = info.n;
            if (info && info.g === 'pdf') S.run.curPdf = true;
            if (S.run.kind !== 'bulk') renderRunBox(); else renderProgress();
          });
          for (let f = fMark; f < files.length; f++) bytes += files[f].data.length;
          results.push({ ...it, ...r, status: 'ok' });
        } catch (e) {
          if (e instanceof SessionError) { files.length = fMark; errors.length = eMark; throw e; }   // redo this document on resume
          results.push({ ...it, status: 'FAILED: ' + e.message }); errors.push(`${it.tips}: ${e.message}`);
        }
      }
    } catch (e) {
      S.run = null;
      if (e instanceof SessionError) {
        S.resume = { title, kind, exporter, remaining: items.slice(cur), carry: { files, errors, results, all }, finish: null };
        setMsg(`⚠ ${e.message}. ${results.length} of ${all.length} done and kept – log in to XENTRY again in this tab, then click Resume.`);
      } else setMsg(e.message === 'cancelled' ? `${title} cancelled – nothing saved.` : `${title} failed: ` + e.message);
      render(); return null;
    }
    S.run = null;
    return { files, errors, results, leftover };
  }
  const busy = () => !!(S.run || S.pending || S.resume);
  async function resumeRun() {
    const r = S.resume; if (!r || S.run) return;
    S.resume = null; S.msg = '';
    const out = await runDocs(r.title, r.remaining, r.kind, r.exporter, r.carry);
    if (!out) { if (S.resume) S.resume.finish = r.finish; return; }
    await r.finish(out);
  }
  function discardResume() { if (!S.resume) return; S.resume = null; setMsg('Interrupted download discarded – nothing saved.'); }
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
    if (busy()) return;
    if (!sessionOK()) { setMsg('Session values missing – open Settings and fill Outlet / User, or open any topic once so they can be detected.'); return; }
    const items = pendingItems().slice(0, S.settings.batchSize);
    if (!items.length) { setMsg('Everything in the index is exported.'); return; }
    const n = nextBatch();
    const out = await runDocs(`Batch ${n}`, items, 'bulk');
    if (!out) { if (S.resume) S.resume.finish = o => finishBatch(n, o); return; }
    await finishBatch(n, out);
  }
  async function finishBatch(n, out) {
    const { files, errors, results, leftover } = out;
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
    setMsg(leftover.length ? `Batch ${n} reached ${capMB()} MB after ${results.length} documents – ready for review. The other ${leftover.length} stay pending for the next batch.` : `Batch ${n} ready for review.`);
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
    railFlash = Date.now() + 6000; setTimeout(render, 6100);
    setMsg(`Downloaded ${p.fname}.`);
    render();
    if (S.settings.autoContinue && nextBatch()) setTimeout(() => prepareBatch(), Math.max(800, randDelay()));
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
  // The last topic search the Reader ran (recorded by the page probe), replayed page by page with our own paging.
  const SEARCH_LIMIT = 300;
  function readerSearch() { try { const b = document.documentElement.dataset.tipsxLastSearch; return b ? JSON.parse(b) : null; } catch (e) { return null; } }
  function searchLabel(b) { const t = b && ['searchText', 'fullText', 'freeText', 'searchTerm', 'query', 'docName'].map(k => b[k]).find(v => typeof v === 'string' && v.trim()); return t ? `“${t.trim()}”` : ''; }
  async function fetchReaderSearch() {
    const base = readerSearch(); if (!base) throw new Error('Run a search in TIPS first.');
    const size = S.settings.pageSize || 20, out = [], seen = new Set(); let total = 0;
    for (let p = 1; p <= 200; p++) {
      setMsg(`Reading your TIPS search… page ${p}${total ? ' of ' + Math.ceil(total / size) : ''}`);
      const r = await fetch('/tips/topic-service/api/v1/topics/search?' + Q(), { method: 'POST', credentials: 'include', headers: H(), body: JSON.stringify({ ...base, totalHitsCountOnly: false, pagination: { pageNumber: p, pageSize: size } }) });
      if (r.status === 401 || r.status === 403) throw new SessionError('Session expired (HTTP ' + r.status + ')');
      if (!r.ok) throw new Error('Search failed: HTTP ' + r.status);
      const j = await r.json(); total = j.totalHits || 0;
      if (total > SEARCH_LIMIT) throw new Error(`Your TIPS search found ${fmtN(total)} topics – narrow it to ${SEARCH_LIMIT} or fewer, or use Bulk export.`);
      if (!j.hits || !j.hits.length) break;
      for (const h of j.hits) if (!seen.has(h.tipsId)) { seen.add(h.tipsId); out.push({ tips: h.tips, tipsId: h.tipsId, version: h.version, title: h.title, mdate: h.modificationDate }); }
      if (p * size >= total) break;
      await sleep(300);
    }
    S.msg = '';
    return { found: out, total };
  }
  async function lookupReaderSearch() {
    if (busy()) { setMsg('Finish, resume or discard the current download first.'); return; }
    if (!sessionOK()) { setMsg('Session values missing – open ⚙ Settings.'); return; }
    S.single = { phase: 'looking' }; render();
    try { const { found, total } = await fetchReaderSearch(); S.single = { phase: 'looked', found, problems: [], fromSearch: { total, label: searchLabel(readerSearch()) } }; }
    catch (e) { S.single = null; throw e; }
    render();
  }

  // ---------------------------------------------------------------- 5: newer versions of recent downloads
  const recentVers = r => r.vers || (r.docs === 1 && r.v != null ? { [r.tips[0]]: +r.v } : {});
  const newestKnown = tips => { const i = S.index.find(x => x.tips === tips); return Math.max(S.latest[tips] || 0, i ? +i.version || 0 : 0); };
  const recentUpdates = r => Object.entries(recentVers(r)).filter(([t, v]) => newestKnown(t) > v).map(([t, v]) => ({ tips: t, have: v, now: newestKnown(t) }));
  async function checkRecentUpdates() {
    if (busy()) { setMsg('Finish, resume or discard the current download first.'); return; }
    const all = [...new Set(S.recent.flatMap(r => Object.keys(recentVers(r))))].slice(0, 40);
    if (!all.length) return;
    for (const [k, t] of all.entries()) {
      setMsg(`Checking for newer versions… ${k + 1} of ${all.length}`);
      const hit = await searchByNumber(t.toUpperCase());
      if (hit) S.latest[t] = +hit.version;
      await sleep(300);
    }
    const n = S.recent.reduce((a, r) => a + recentUpdates(r).length, 0);
    setMsg(n ? `${n} of your recent downloads ${n === 1 ? 'has' : 'have'} a newer version in TIPS.` : 'All your recent downloads are up to date.');
  }
  const verTag = o => { if (!o) return ''; const v = o.versions;
    return (o.allVers ? '' : v.length === 1 ? `_v${v[0]}` : v.every((x, i) => !i || x === v[i - 1] + 1) ? `_v${v[0]}-v${v.at(-1)}` : '_v' + v.join('_v')) + (o.dropAtt ? '_no-attachments' : ''); };
  const selectionName = found => found.length === 1 ? `TIPS_${safe(found[0].tips)}${verTag(found[0].opts)}.zip` : `TIPS_selection_${new Date().toISOString().slice(0, 10)}_${found.length}docs.zip`;
  async function lookupSpecific(text) {
    if (busy()) { setMsg('Finish, resume or discard the current download first.'); return; }
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
    if (!sg || sg.phase !== 'looked' || !sg.found.length || busy()) return;
    const out = await runDocs(sg.found.length === 1 ? sg.found[0].tips : `${sg.found.length} documents`, sg.found, 'single');
    if (!out) { if (S.resume) S.resume.finish = o => finishSingle(sg, o); return; }   // cancelled or session lost
    await finishSingle(sg, out);
  }
  async function finishSingle(sg, out) {
    const found = sg.found, { files, errors, results, leftover } = out;
    const problems = [...sg.problems, ...leftover.map(it => ({ token: it.tips, kind: 'capped', text: `Not downloaded – the zip reached ${capMB()} MB. Download it separately.`, msg: `${it.tips}: not downloaded (zip size limit)` }))];
    if (S.settings.files.manifest) files.unshift({ name: `_manifest.csv`, data: txt(manifestCsv(results)) });
    if (errors.length || problems.length) files.unshift({ name: `_errors.txt`, data: txt([...problems.map(p => p.msg), ...errors].join('\r\n')) });
    const blob = makeZip(files);
    const done = results.filter(r => r.status === 'ok'), fname = selectionName(found);
    saveBlob(blob, fname);   // explicit request -> download straight away; does not change bulk-export progress
    const sum = summarize(fname, blob, results, errors);
    S.single = { phase: 'done', fname, sum, problems };
    S.recent.unshift({ fname, tips: results.map(f => f.tips), v: results.length === 1 ? results[0].version : null, vers: Object.fromEntries(done.map(r => [r.tips, +r.version])),
      sizeMB: sum.sizeMB, docs: results.length, date: new Date().toISOString() });
    S.recent = S.recent.slice(0, 10);
    await saveRecent();
    railFlash = Date.now() + 6000; setTimeout(render, 6100);
    render();
  }

  // ---------------------------------------------------------------- UI
  // A full-height drawer on the right, styled with the Reader's own theme (xy-* tokens, Corpo fonts the page
  // already loads), opened from the Reader's ⋮ menu (or the toolbar icon). The page to its left is dimmed.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;top:0;left:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'open' });
  let visible = false, justOpened = false, showSettings = false, liText = '', view = 'single';   // view: 'single' | 'bulk'
  let railFlash = 0, lastView = 'single';
  let sDraft = {};   // unsaved Settings edits, kept across re-renders until Save / close / Re-detect
  const EXT_VERSION = (hasChrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || 'dev';
  const HELP_URL = 'https://github.com/MaydayDragal/TIPs-Exporter#readme';
  let diag = null;   // results of "Check setup"
  const S_FIELDS = ['s_bs', 's_delay', 's_delay2', 's_ps', 's_outlet', 's_user', 's_ver'];
  const css = `
  :host{all:initial}
  *{box-sizing:border-box}
  .dim,.dr,.pk{--f:"Mercedes-Benz Corpo S Text Regular","XF CorpoS normal",Arial,sans-serif;--ft:"Mercedes-Benz Corpo A Title Condensed","XF CorpoA normal",Georgia,serif;
    --tx:#333333;--lab:#595959;--dis:#9b9b9b;--blue:#006EFF;--blueH:#0058cc;--blueP:#002c66;--soft:#e6f1ff;--sel:#cce2ff;--softP:#99c5ff;
    --grey:#595959;--greyH:#474747;--bar:#dedede;--barB:#cdcdcd;--stroke:#7a7a7a;--div:#dedede;--row2:#eeeeee;
    --ok:#018601;--okbg:#e6f3e6;--al:#EE7100;--albg:#fdf1e6;--er:#EA060A;--erbg:#fde6e7;--sh:0 1px 3px 0 rgba(0,0,0,.2)}
  .dim{position:fixed;left:0;right:0;bottom:0;background:rgba(0,0,0,.35)}
  .dr{position:fixed;right:0;bottom:0;width:min(560px,95vw);display:flex;flex-direction:column;background:#fff;border-left:1px solid var(--stroke);
    box-shadow:-6px 0 20px rgba(0,0,0,.25);color:var(--tx);font:14px/1.4 var(--f);-webkit-font-smoothing:antialiased}
  .dr.anim{animation:tipsx-in .15s ease-out} @keyframes tipsx-in{from{transform:translateX(32px);opacity:.5}}
  .hd{flex:none;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 8px 4px 20px}
  .ttl{display:flex;align-items:baseline;gap:12px;min-width:0} .ttl h2{margin:0;font:400 24px/1.2 var(--ft);white-space:nowrap}
  .st{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hb{display:flex;align-items:center;flex:none}
  .ib{width:48px;height:48px;border:0;border-radius:0;background:transparent;color:var(--tx);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
  .ib:hover{background:var(--soft)} .ib[aria-pressed=true]{background:var(--sel)}
  .sep{width:1px;height:32px;background:var(--div);margin:0 6px}
  .tabs{flex:none;display:flex;margin:0 20px}
  .tab{flex:1;height:48px;border:0;border-bottom:3px solid var(--dis);border-radius:0;background:#fff;font:14px var(--f);color:var(--tx);cursor:pointer}
  .tab:hover{background:var(--soft)} .tab[aria-selected=true]{background:var(--sel);border-bottom-color:var(--blue)}
  .note{flex:none;display:flex;gap:8px;align-items:flex-start;margin:12px 20px 0;padding:8px 12px;background:var(--soft);font-size:13px}
  .note span{flex:1} .note button{border:0;background:none;cursor:pointer;font-size:16px;line-height:1;color:var(--lab);padding:0}
  .body{flex:1;min-height:0;overflow:auto;padding:16px 20px 20px;display:flex;flex-direction:column;gap:16px}
  .body::-webkit-scrollbar{width:6px}.body::-webkit-scrollbar-thumb{background:#cacaca;border-radius:1ex}
  .ft{flex:none;min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px 10px 20px;background:var(--row2);flex-wrap:wrap}
  .sess{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--lab)} .acts{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto}
  h3{margin:0;font:400 22px/1.2 var(--ft);color:var(--tx)}
  .sec{display:flex;flex-direction:column;gap:8px}
  .mut{color:var(--lab)} .sm{font-size:13px} .okc{color:var(--ok)} .acc{color:var(--blue)} .alc{color:var(--al)} .erc{color:var(--er)}
  .b{height:40px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 16px;border:0;border-radius:0;font:14px var(--f);cursor:pointer;white-space:nowrap}
  .ft .b{height:44px}
  .b.pri{background:var(--blue);color:#fff;box-shadow:var(--sh)} .b.pri:hover{background:var(--blueH)} .b.pri:active{background:var(--blueP)}
  .b.sec{background:var(--grey);color:#fff;box-shadow:var(--sh)} .b.sec:hover{background:var(--greyH)}
  .b.bar{background:var(--bar);color:var(--tx);border:1px solid var(--barB)} .b.bar:hover{background:var(--barB)}
  .b.dan{background:#fff;color:var(--er);border:1px solid var(--er)} .b.dan:hover{background:var(--erbg)}
  .b.sm{height:32px;padding:0 10px;font-size:13px} .b.full{width:100%}
  .b:disabled,.b:disabled:hover{background:#bdbdbd;color:#fff;border-color:#bdbdbd;box-shadow:none;cursor:default}
  .b:focus-visible,.ib:focus-visible,.tab:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
  textarea{width:100%;min-height:96px;padding:10px 16px;border:1px solid var(--stroke);border-radius:0;background:#fff;font:14px/1.4 var(--f);color:var(--tx);resize:vertical}
  textarea:hover,.fld input:hover{border-color:#474747}
  textarea:focus,.fld input:focus{outline:none;border-color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue)}
  textarea::placeholder{color:var(--dis)} textarea:disabled{color:var(--dis);border-color:#bdbdbd}
  .badge{display:inline-block;min-width:18px;padding:2px 6px;border-radius:11px;background:var(--blue);color:#fff;font-size:12px;line-height:12px;text-align:center}
  .cnt{display:flex;align-items:center;gap:8px;font-size:16px}
  .card{min-height:56px;padding:8px 16px;background:#fff;box-shadow:var(--sh);display:flex;align-items:center;gap:12px} .card.sel{background:var(--sel)}
  .card>svg,.card .ic{flex:none} .card .bd{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .sp{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .ban{display:flex;gap:12px;align-items:flex-start;padding:12px 16px} .ban.ok{background:var(--okbg)} .ban.al{background:var(--albg)} .ban.er{background:var(--erbg)}
  .ban .ic{display:flex;margin-top:1px} .ban.ok .ic{color:var(--ok)} .ban.al .ic{color:var(--al)} .ban.er .ic{color:var(--er)}
  .ban .bd{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px} .ban b{font-weight:700}
  .kv>div{display:grid;grid-template-columns:140px minmax(0,1fr);padding:10px 0;border-bottom:1px solid var(--div)} .kv>div>span:first-child{color:var(--lab)}
  .pbar{height:8px;background:var(--bar)} .pbar i{display:block;height:100%;background:var(--blue)} .pbar.thin{height:4px}
  ol.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px} ol.steps li{display:flex;gap:8px}
  .spin{display:inline-flex;animation:tipsx-spin .9s linear infinite} @keyframes tipsx-spin{to{transform:rotate(360deg)}}
  .grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px} .g21{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:8px}
  .rule{padding:12px 0;border-top:1px solid var(--div);border-bottom:1px solid var(--div);display:flex;flex-direction:column;gap:14px}
  label.tg{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer}
  .tgl{appearance:none;-webkit-appearance:none;width:36px;height:16px;border-radius:8px;background:var(--bar);position:relative;cursor:pointer;flex:none;margin:0}
  .tgl::after{content:'';position:absolute;top:-2px;left:-2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:var(--sh)}
  .tgl:checked{background:var(--softP)} .tgl:checked::after{left:18px;background:var(--blue)} .tgl:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
  label.ck{display:flex;align-items:center;gap:10px;cursor:pointer} label.ck:has(input:disabled){cursor:default}
  .ck input{appearance:none;-webkit-appearance:none;width:18px;height:18px;border:1px solid var(--stroke);border-radius:0;background:#fff;margin:0;display:inline-grid;place-content:center;cursor:pointer;flex:none}
  .ck input::after{content:'';width:4px;height:9px;margin-top:-2px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) scale(0)}
  .ck input:checked{background:var(--blue);border-color:var(--blue)} .ck input:checked::after{transform:rotate(45deg) scale(1)}
  .ck input:disabled{opacity:.5;cursor:default} .ck input:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
  .fgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .fld{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--lab)} .fld .pair{display:flex;align-items:center;gap:6px}
  .fld input{width:150px;height:40px;padding:0 12px;border:1px solid var(--stroke);border-radius:0;font:14px var(--f);color:var(--tx)} .fld input.s{width:80px}
  details summary{cursor:pointer;height:40px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border:1px solid var(--stroke);color:var(--lab);list-style:none}
  details summary::-webkit-details-marker{display:none}
  pre{white-space:pre-wrap;font-size:12px;max-height:140px;overflow:auto;background:#fff;padding:6px;margin:6px 0 0}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px} td,th{padding:6px 4px;border-bottom:1px solid var(--div);text-align:left} th{font-weight:700}
  code{font-size:12px;color:var(--lab)}
  .pk{position:fixed;width:380px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;background:#fff;border:1px solid var(--stroke);
    box-shadow:0 8px 24px rgba(0,0,0,.3);color:var(--tx);font:14px/1.4 var(--f);-webkit-font-smoothing:antialiased}
  .pk .phd{display:flex;align-items:flex-start;gap:8px;padding:12px 4px 4px 16px} .pk .phd .bd{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-top:4px}
  .pk .one{white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .pk .ib{width:40px;height:40px}
  .pk .pbd{padding:8px 16px 14px;display:flex;flex-direction:column;gap:10px}
  .pk .vl{max-height:min(300px,40vh);overflow:auto;border-top:1px solid var(--div);border-bottom:1px solid var(--div)}
  .pk .vl::-webkit-scrollbar{width:6px}.pk .vl::-webkit-scrollbar-thumb{background:#cacaca;border-radius:1ex}
  .pk .vr{align-items:flex-start;padding:9px 4px} .pk .vr+.vr{border-top:1px solid var(--div)} .pk .vr input{margin-top:1px}
  .pk .vr .bd{flex:1;min-width:0;display:flex;flex-direction:column} .pk .vr .l1{display:flex;align-items:baseline;gap:8px} .pk .dt{margin-left:auto}
  .pk .tag{font-size:12px;line-height:16px;padding:0 6px;background:var(--sel);color:var(--blueP)}
  .pk .lk{border:0;background:none;padding:0;color:var(--blue);font:13px var(--f);cursor:pointer} .pk .lk:hover{text-decoration:underline} .pk .lk:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
  .pk .ld{display:flex;align-items:center;gap:8px;padding:6px 0}
  .pk .pft{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;background:var(--row2)}
`;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function setMsg(m) { S.msg = m; render(); }
  // top of the drawer = bottom of the Reader's black header
  function topOffset() { const n = document.querySelector('xy-c-side-navigation'); const t = n ? Math.round(n.getBoundingClientRect().top) : 56; return t > 0 && t < 200 ? t : 56; }
  window.addEventListener('resize', () => { if (visible) render(); });
  // Esc closes the drawer (and doesn't reach the Reader while the drawer is open)
  const FOCUSABLE = 'button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),summary,a[href],[tabindex]:not([tabindex="-1"])';
  window.addEventListener('keydown', e => {
    if (!visible || !e.isTrusted) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); openDrawer(false); return; }
    if (e.key === 'Tab') {   // keep keyboard focus inside the drawer, like the Reader's dialogs
      const f = [...root.querySelectorAll('.dr ' + FOCUSABLE.split(',').join(',.dr '))].filter(el => el.offsetParent !== null || el.getClientRects().length);
      if (!f.length) return;
      const i = f.indexOf(root.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    }
  }, true);
  let returnFocus = null;
  function openDrawer(open) {
    if (open && pick) closePick(null);
    if (open && !visible) { justOpened = true; returnFocus = document.activeElement; }
    const wasVisible = visible;
    visible = open;
    if (!open) { showSettings = false; sDraft = {}; }
    render();
    if (!open && wasVisible) {   // back to the ⋮ button (the menu item that opened us is gone by now)
      const t = document.querySelector('#auxMenu0 button') || (returnFocus && returnFocus.isConnected ? returnFocus : null);
      if (t && t.focus) t.focus();
    }
  }

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

  const banner = (kind, title, bodyHtml = '', action = '') => `<div class="ban ${kind}"><span class="ic">${svg(kind === 'ok' ? '<path d="M20 6L9 17l-5-5"></path>' : '<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>', 20, 2)}</span><div class="bd"><b>${title}</b>${bodyHtml}</div>${action}</div>`;
  const kv = rows => `<div class="kv">${rows.map(([a, b]) => `<div><span>${esc(a)}</span><span>${esc(b)}</span></div>`).join('')}</div>`;
  const pbar = (pct, thin, id) => `<div class="pbar${thin ? ' thin' : ''}"><i ${id ? `id="${id}"` : ''} style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></div>`;

  // ---- single LI  (each view returns {body, actions})
  function vSingle() {
    const sg = S.single, run = S.run && S.run.kind === 'single' ? S.run : null;
    const blocked = busy(), F = S.settings.files;
    if (run) return { body: `<div id="runbox">${vSingleRun(run)}</div>`, actions: `<button class="b dan" id="cancel">${I.x}Cancel download</button>` };
    if (sg && sg.phase === 'done') return vSingleDone(sg);
    const looking = sg && sg.phase === 'looking', looked = sg && sg.phase === 'looked';
    let body = `<div class="sec"><h3>Download LI documents</h3>
        <textarea id="li" rows="3" aria-label="LI numbers" placeholder="LI42.10-P-078779&#10;078780, 061245 …" ${blocked || looking ? 'disabled' : ''}>${esc(liText)}</textarea>
        ${looked ? '' : '<span class="mut">Full numbers, or a unique ending such as 078779 once the index is built. Separate several with spaces, commas or new lines. Ctrl+Enter looks them up.</span>'}</div>`;
    if (looked) body += vLooked(sg);
    else body += `<span class="mut">Includes the current PDF, every prior version, attachments${F.histCsv || F.histJson ? ', revision history' : ''}${F.attCsv ? ' and the links list' : ''}.</span>`
      + (blocked ? '<span class="alc">A download is running, waiting for approval or waiting to be resumed – finish it first.</span>' : '');
    const rs = !looked && readerSearch();
    if (rs) body += `<div class="card"><div class="bd"><b>Your current TIPS search${searchLabel(rs) ? ' ' + esc(searchLabel(rs)) : ''}</b>
        <span class="mut sm">Download every topic it found (up to ${SEARCH_LIMIT}), with all versions and attachments.</span></div>
        <button class="b bar" id="cursearch" ${blocked || looking ? 'disabled' : ''}>Use search</button></div>`;
    body += vRecent(sg);
    const actions = looked
      ? `<button class="b bar" id="clear">Clear</button><button class="b pri" id="dlfound" ${sg.found.length ? '' : 'disabled'}>${I.dl}Download ${sg.found.length || ''}</button>`
      : `<button class="b pri" id="look" ${blocked || looking ? 'disabled' : ''}>${I.search}${looking ? 'Looking up…' : 'Look up'}</button>`;
    return { body, actions };
  }
  function vLooked(sg) {
    const n = sg.found.length + sg.problems.length;
    return (sg.fromSearch ? `<div class="cnt">From your TIPS search${sg.fromSearch.label ? ' ' + esc(sg.fromSearch.label) : ''} : <span class="badge">${sg.found.length}</span><span class="mut" style="font-size:14px">topic${sg.found.length === 1 ? '' : 's'}</span></div>`
      : `<div class="cnt">Found in TIPS : <span class="badge">${sg.found.length}</span><span class="mut" style="font-size:14px">of ${n} entr${n === 1 ? 'y' : 'ies'}</span></div>`) + `
      ${sg.found.map(f => `<div class="card"><span class="okc ic">${svg('<path d="M20 6L9 17l-5-5"></path>', 20, 2.2)}</span><div class="bd">
        <div class="sp"><span>${esc(f.tips)}</span><span class="mut sm">v${esc(f.version)} · ${Math.max(0, f.version - 1)} prior</span></div>
        <span>${esc(f.title)}</span>${f.src ? `<span class="mut sm">from “${esc(f.src)}”</span>` : ''}</div></div>`).join('')}
      ${sg.problems.map(p => banner('al', esc(p.token), `<span>${esc(p.text)}</span>${p.matches ? `<span class="mut sm">${esc(p.matches.join(', '))}${p.count > 3 ? ' …' : ''}</span>` : ''}`)).join('')}
      ${sg.found.length ? `<span class="mut sm">Saves as ${esc(selectionName(sg.found))}</span>` : ''}`;
  }
  function vSingleRun(run) {
    const doneN = run.results.length, st = run.step, gi = st ? ['data', 'pdf', 'att', 'prior'].indexOf(st.g) : -1;
    const frac = !st ? 0 : st.g === 'data' ? .1 : st.g === 'pdf' ? .2 : st.g === 'att' ? .2 + .3 * st.k / st.n : .5 + .5 * st.k / st.n;
    let steps = '';
    if (st) {
      const L = [];
      L.push(gi <= 1 ? ['cur', st.g === 'data' ? 'Topic data' : `Current PDF v${st.v}`] : ['done', run.curPdf ? 'Topic data &amp; current PDF' : 'Topic data']);
      if (run.attN) L.push(gi === 2 ? ['cur', `Attachment ${st.k} of ${st.n}`] : gi > 2 ? ['done', `${run.attN} attachment${run.attN > 1 ? 's' : ''}`] : null);
      if (gi === 3) L.push(['cur', `Prior version v${st.v} – ${st.k} of ${st.n}`]);
      steps = `<ol class="steps">${L.filter(Boolean).map(([k, t]) => k === 'done' ? `<li class="mut"><span class="okc">✓</span>${t}</li>` : `<li><span class="acc spin">${svg('<circle cx="12" cy="12" r="8" stroke-opacity=".25"></circle><path d="M12 4a8 8 0 0 1 8 8"></path>', 16, 2.4)}</span>${t}</li>`).join('')}</ol>`;
    }
    return `<div class="sec"><div class="sp"><h3>Downloading</h3><span style="font-size:16px">Document ${Math.min(doneN + 1, run.total)} of ${run.total}</span></div>${pbar(100 * (doneN + frac) / run.total, false, 'pbar')}</div>
      ${run.items.map((it, k) => {
        const r = run.results[k];
        if (r) return `<div class="card"><div class="bd"><div class="sp"><span>${esc(it.tips)}</span>${r.status === 'ok' ? '<span class="okc">✓ done</span>' : '<span class="erc">failed</span>'}</div></div></div>`;
        if (k === doneN) return `<div class="card sel"><div class="bd" style="gap:8px"><div class="sp"><b>${esc(it.tips)}</b><span class="acc">in progress</span></div>
          ${steps || `<span class="mut" id="plabel">${esc(runLabel(run))}</span>`}</div></div>`;
        return `<div class="card"><div class="bd"><div class="sp"><span class="mut">${esc(it.tips)}</span><span class="mut">queued</span></div></div></div>`;
      }).join('')}
      <span class="mut">Saves to your Downloads folder when finished. Cancelling saves nothing; bulk export progress isn't affected.</span>`;
  }
  function vSingleDone(sg) {
    const m = sg.sum, np = sg.problems.length;
    const body = banner('ok', 'Saved to Downloads', `<span class="mut" style="overflow-wrap:anywhere">${esc(sg.fname)}</span>`)
      + kv([['Size', `${m.sizeMB} MB`], ['Documents', `${m.ok} of ${m.docs}`], ['Attachments', m.att], ['Prior versions', m.prev]])
      + (m.errors.length ? banner('er', `${m.errors.length} file${m.errors.length > 1 ? 's' : ''} could not be saved`, `<details><summary>Show details</summary><pre>${esc(m.errors.join('\n'))}</pre></details><span class="mut sm">Also listed in _errors.txt inside the zip.</span>`) : '')
      + (np ? banner('al', `${np} entr${np > 1 ? 'ies' : 'y'} skipped`, sg.problems.map(p => `<span>${esc(p.token)} – ${esc(p.text)}</span>`).join(''), '<button class="b bar sm" id="fix" style="align-self:center">Fix</button>') : '')
      + vRecent(sg);
    return { body, actions: '<button class="b pri" id="newdl">New download</button>' };
  }
  function vRecent(sg) {
    if (!S.recent.length) return '';
    const blocked = busy();
    return `<div class="sec" style="padding-top:8px"><div class="sp" style="align-items:center"><h3>Recent downloads</h3><button class="b bar sm" id="rcheck" ${blocked ? 'disabled' : ''}>${I.redo}Check for updates</button></div>
      ${S.recent.slice(0, 5).map((r, k) => {
        const name = r.docs === 1 ? r.tips[0] : `${r.docs} documents`, upd = recentUpdates(r);
        const meta = (r.docs === 1 ? `v${r.v} · ` : `${r.tips.slice(0, 2).join(', ')}${r.docs > 2 ? ' …' : ''} · `) + `${r.sizeMB} MB · ${when(r.date)}`;
        const note = upd.length ? `<span class="alc sm">${upd.length === 1 ? `Newer version in TIPS: ${esc(upd[0].tips)} v${upd[0].now} (you have v${upd[0].have})` : `${upd.length} documents have a newer version in TIPS`}</span>` : '';
        return `<div class="card${k === 0 && sg && sg.phase === 'done' && sg.fname === r.fname ? ' sel' : ''}"><div class="bd"><span>${esc(name)}</span><span class="mut sm">${esc(meta)}</span>${note}</div>
          ${upd.length ? `<button class="b pri sm" data-upd="${k}" ${blocked ? 'disabled' : ''}>Download update</button>` : ''}
          <button class="b bar" style="width:40px;padding:0" data-redo="${k}" aria-label="Download ${esc(name)} again" title="Look up again" ${blocked ? 'disabled' : ''}>${I.redo}</button></div>`;
      }).join('')}</div>`;
  }

  // ---- bulk
  function vBulk() {
    const s = S.settings, run = S.run && S.run.kind === 'bulk' ? S.run : null, pen = S.pending, dc = doneCount(), nb = nextBatch(), pendN = pendingItems().length;
    const pct = S.index.length ? 100 * dc / S.index.length : 0;
    let body = `<div class="sec"><h3>Progress</h3>
        <div class="cnt">Total topics : <span class="badge">${S.index.length ? fmtN(S.index.length) : '0'}</span></div>
        <div style="display:flex;gap:24px;flex-wrap:wrap"><span>Exported : <b>${fmtN(dc)}</b></span><span>Pending : <b>${fmtN(pendN)}</b></span><span>Next batch : <b>${nb ?? '–'}</b></span></div>
        ${pbar(pct)}<span class="mut">${pct.toFixed(1)}% · about ${remainingBatches()} batches of ${s.batchSize} left</span></div>`;
    let actions = '';
    const toggles = `<div class="rule"><label class="tg">Auto-continue after each download<input type="checkbox" class="tgl" id="autoc" ${s.autoContinue ? 'checked' : ''}></label>
        <label class="tg">Auto-approve (download without asking)<input type="checkbox" class="tgl" id="autoa" ${s.autoApprove ? 'checked' : ''}></label></div>`;
    if (run) {
      body += `<div class="sec"><div class="sp"><h3>${esc(run.title)}${run.paused ? ' <span class="alc" style="font:14px var(--f)">· paused</span>' : ''}</h3><span style="font-size:16px">Document ${run.i} of ${run.total}</span></div>
          ${pbar(100 * (run.i - 1) / run.total, false, 'pbar')}</div>
        <div class="card sel"><div class="bd"><b>${esc((run.items[run.results.length] || {}).tips || '')}</b><span class="mut" id="plabel">${esc(runLabel(run))}</span></div></div>
        <span class="mut">Nothing downloads until you approve the batch. Cancel discards it; its documents stay pending.</span>` + toggles;
      actions = `<button class="b dan" id="cancel">Cancel batch</button><button class="b sec" id="pause">${run.paused ? I.play + 'Resume' : I.pause + 'Pause'}</button>`;
    } else if (S.run) {
      body += `<div class="card sel"><div class="bd"><b>A single-LI download is running</b><span class="mut" id="plabel">${esc(runLabel(S.run))}</span></div></div>`;
      actions = `<button class="b dan" id="cancel">${I.x}Cancel download</button>`;
    } else if (pen) {
      const m = pen.summary;
      body = banner('ok', `Batch ${pen.n} is ready`, `<span class="mut">${esc(m.fname)}</span>`)
        + kv([['Size', `${m.sizeMB} MB`], ['Documents', `${m.ok} of ${m.docs}`], ['Attachments', m.att], ['Prior versions', m.prev], ['Range', m.range]])
        + (m.errors.length ? banner('al', `${m.errors.length} file${m.errors.length > 1 ? 's' : ''} could not be saved`, `<details><summary>Show details</summary><pre>${esc(m.errors.join('\n'))}</pre></details>`) : '<span class="okc">No errors</span>');
      actions = `<button class="b bar" id="discard">Discard</button><button class="b pri" id="approve">${I.check}Approve &amp; download</button>`;
    } else {
      body += toggles + `<div class="sec"><h3>Index &amp; progress log</h3><div class="grid2">
          <button class="b bar" id="refresh" ${!S.index.length ? 'disabled' : ''}>${I.redo}Check new</button>
          <button class="b bar" id="build">${S.index.length ? 'Rebuild index' : 'Build index'}</button>
          <button class="b bar" id="imp">Import log</button>
          <button class="b bar" id="exp" ${!S.index.length ? 'disabled' : ''}>${I.dl}Save log</button>
        </div><input type="file" id="file" accept=".csv" style="display:none"></div>`;
      if (S.history.length) body += `<details><summary>Batch history (${S.history.length})<span>›</span></summary>
          <table><tr><th>#</th><th>Size</th><th>Docs</th><th>Att.</th><th>Prev.</th><th>Err.</th></tr>
          ${S.history.slice().reverse().map(x => `<tr><td>${x.n}</td><td>${x.sizeMB} MB</td><td>${x.ok}/${x.docs}</td><td>${x.att}</td><td>${x.prev}</td><td>${x.errors}</td></tr>`).join('')}</table></details>`;
      actions = `<button class="b pri" id="prep" ${!S.index.length || !nb ? 'disabled' : ''}>${I.dl}${nb ? `Prepare batch ${nb} · ${Math.min(s.batchSize, pendN)} documents` : S.index.length ? 'Everything exported' : 'Build the index first'}</button>`;
    }
    return { body, actions };
  }

  // ---- settings
  function vSettings() {
    const s = S.settings;
    const body = `<h3>Settings</h3>
      <label class="fld">Batch size <input class="s" type="number" id="s_bs" value="${s.batchSize}" min="1" max="500"></label>
      <label class="fld">Delay between documents (ms) <span class="pair"><input class="s" type="number" id="s_delay" value="${s.delayMs}" min="0" step="250" aria-label="Minimum delay"> – <input class="s" type="number" id="s_delay2" value="${s.delayMaxMs}" min="0" step="250" aria-label="Maximum delay"></span></label>
      <label class="fld">Search page size <span class="pair"><span class="${s.pageSizeSrc === 'detected' ? 'okc' : s.pageSizeSrc === 'manual' ? 'mut' : 'alc'}">${s.pageSizeSrc === 'detected' ? '✓ matches TIPS' : s.pageSizeSrc === 'manual' ? 'set manually' : 'not detected yet'}</span><input class="s" type="number" id="s_ps" value="${s.pageSize}" min="1" max="500"></span></label>
      <label class="fld">Outlet <input type="text" id="s_outlet" value="${esc(s.outlet)}"></label>
      <label class="fld">User <input type="text" id="s_user" value="${esc(s.user)}"></label>
      <label class="fld">Reader version <input type="text" id="s_ver" value="${esc(s.ver)}"></label>
      <div class="sec" style="padding-top:12px;border-top:1px solid var(--div)"><b>Data files to include</b><span class="mut">PDFs and attachments are always saved.</span>
        <div class="fgrid">
          <label class="ck"><input type="checkbox" id="f_docJson" ${s.files.docJson ? 'checked' : ''}> Document data <code>.json</code></label>
          <label class="ck"><input type="checkbox" id="f_histCsv" ${s.files.histCsv ? 'checked' : ''}> Revision history <code>.csv</code></label>
          <label class="ck"><input type="checkbox" id="f_histJson" ${s.files.histJson ? 'checked' : ''}> Revision history <code>.json</code></label>
          <label class="ck"><input type="checkbox" id="f_attCsv" ${s.files.attCsv ? 'checked' : ''}> Links list <code>.csv</code></label>
          <label class="ck"><input type="checkbox" id="f_manifest" ${s.files.manifest ? 'checked' : ''}> Manifest <code>.csv</code></label>
          <label class="ck" title="Always included – needed to resume"><input type="checkbox" checked disabled> Progress log <code>.csv</code></label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="b bar sm" id="f_all">All</button><button class="b bar sm" id="f_csv">CSV only</button><button class="b bar sm" id="f_json">JSON only</button><button class="b bar sm" id="f_none">None</button></div>
        ${!s.files.attCsv ? '<span class="alc sm">Links to other LIs are only recorded in the links list CSV.</span>' : ''}
      </div>
      <div class="sec" style="padding-top:12px;border-top:1px solid var(--div)"><b>Check setup</b>
        <span class="mut">Checks that the exporter can find everything it needs on this TIPS page.</span>
        ${diag ? `<div class="kv">${diag.map(([ok, a, b]) => `<div><span>${ok === true ? '<span class="okc">✓</span>' : ok === false ? '<span class="erc">✗</span>' : '<span class="mut">–</span>'} ${esc(a)}</span><span>${esc(b)}</span></div>`).join('')}</div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="b bar sm" id="s_check">Check setup</button><a class="sm" href="${HELP_URL}" target="_blank" rel="noopener" style="color:var(--blue)">Help &amp; instructions</a></div>
      </div>`;
    return { body, actions: '<button class="b bar" id="s_detect">Re-detect session</button><button class="b pri" id="s_save">Save</button>' };
  }

  function checkSetup() {
    const s = S.settings, nav = document.querySelector('xy-c-side-navigation'), topic = /\/search\/topics\/\d+\/\d+/.test(location.pathname);
    const fontOk = (() => { try { return [...document.fonts].some(f => /Corpo S Text Regular|XF CorpoS/i.test(f.family) && f.status === 'loaded'); } catch (e) { return null; } })();
    const cv = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1];
    return [
      [sessionOK(), 'Session', sessionOK() ? `user ${s.user} · outlet ${s.outlet} · Reader v${s.ver}` : 'not detected – open any topic, then Re-detect session'],
      [s.pageSizeSrc === 'default' ? false : true, 'Search page size', s.pageSizeSrc === 'detected' ? `${s.pageSize} – matches TIPS` : s.pageSizeSrc === 'manual' ? `${s.pageSize} – set manually` : 'not seen yet – run any search in TIPS'],
      [!!nav, 'Drawer position', nav ? `under the header (${topOffset()} px)` : 'header not found – using 56 px'],
      [!!(document.getElementById('auxMenu0') || document.querySelector('footer xy-c-aux-menu')), '⋮ menu', document.getElementById('auxMenu0') ? 'found – TIPS Exporter is added under Settings' : 'not found – use the toolbar icon to open the exporter'],
      [topic ? !!document.querySelector('neo-topic-detail button.xy-i-print') : null, 'Topic toolbar button', topic ? (document.querySelector('button.tipsx-dl') ? 'shown next to Print' : 'Print button not found') : 'open a topic to check'],
      [fontOk, 'TIPS fonts', fontOk ? 'in use' : fontOk === false ? 'not loaded – using Arial/Georgia' : 'could not check'],
      [S.index.length ? true : null, 'Index', S.index.length ? `${fmtN(S.index.length)} topics, ${fmtN(doneCount())} exported` : 'not built (only needed for bulk export and short LI endings)'],
      [cv ? +cv >= 111 : null, 'Chrome', cv ? `version ${cv}` : 'unknown'],
      [true, 'Extension', `v${EXT_VERSION}`]];
  }

  function render() {
    syncRail();
    if (!visible) { root.innerHTML = ''; syncToolbar(); syncRows(); return; }
    // keep typing focus and scroll position across re-renders
    const ae = root.activeElement, focusLi = ae && ae.id === 'li', selA = focusLi ? ae.selectionStart : 0, selB = focusLi ? ae.selectionEnd : 0;
    const oldBody = root.querySelector('.body'), scroll = oldBody && lastView === view ? oldBody.scrollTop : 0; lastView = view;
    const s = S.settings, run = S.run, T = topOffset();
    const status = run ? (run.kind === 'single' ? '<span class="st acc">● Downloading</span>' : run.paused ? `<span class="st alc">● ${esc(run.title)} paused</span>` : `<span class="st acc">● ${esc(run.title)} running</span>`)
      : S.pending ? '<span class="st okc">● Awaiting approval</span>' : view === 'single' && S.single && S.single.phase === 'done' ? '<span class="st okc">● Saved</span>' : '';
    const v = showSettings ? vSettings() : view === 'bulk' ? vBulk() : vSingle();
    if (S.resume && !S.run) {   // an interrupted download waits for the user, whatever tab is open
      const r = S.resume, done = r.carry.results.length, total = r.carry.all.length;
      v.body = banner('al', `${r.kind === 'bulk' ? esc(r.title) : 'Download'} interrupted – ${done} of ${total} done`, '<span>Your XENTRY session ended. Log in again in this tab (keep it open), then click Resume to continue where it stopped. Nothing is lost.</span>') + v.body;
      v.actions = '<button class="b bar" id="rdiscard">Discard</button><button class="b pri" id="resume">Resume</button>';
    }
    root.innerHTML = `<style>${css}</style><div class="dim" id="dim" style="top:${T}px"></div>
      <aside class="dr${justOpened ? ' anim' : ''}" role="dialog" aria-modal="true" aria-label="TIPS Exporter" style="top:${T}px">
        <div class="hd"><div class="ttl"><h2>TIPS Exporter</h2>${status}</div>
          <div class="hb"><button class="ib" id="gear" aria-label="Settings" aria-pressed="${showSettings}">${svg('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>', 22, 1.5)}</button>
            <span class="sep"></span><button class="ib" id="close" aria-label="Close">${svg('<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>', 22, 1.5)}</button></div></div>
        <div class="tabs" role="tablist"><button class="tab" role="tab" id="tosingle" aria-selected="${view === 'single'}">Single LI</button><button class="tab" role="tab" id="tobulk" aria-selected="${view === 'bulk'}">Bulk export</button></div>
        ${S.msg ? `<div class="note" role="status"><span>${esc(S.msg)}</span><button id="msgx" aria-label="Dismiss message">×</button></div>` : ''}
        <div class="body" id="body">${v.body}</div>
        <div class="ft"><span class="sess">${sessionOK() ? `<span class="okc" style="display:flex">${svg('<path d="M20 6L9 17l-5-5"></path>', 16, 2.4)}</span>Session OK · ${esc(s.user)}` : `<span class="alc" style="display:flex">${svg('<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>', 16, 2)}</span>Session not detected – open any topic once, or check ⚙`}</span>
<span class="mut sm">v${esc(EXT_VERSION)}</span>
          <div class="acts">${v.actions}</div></div>
      </aside>`;
    const focusOnOpen = justOpened; justOpened = false;
    const $ = id => root.getElementById(id);
    const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
    const safeRun = fn => async () => { try { await fn(); } catch (e) { S.run = null; setMsg((e instanceof SessionError ? '⚠ ' : 'Error: ') + e.message); } };
    const focusBox = () => { const t = $('li'); if (t) { t.focus(); t.selectionStart = t.selectionEnd = t.value.length; } };
    on('dim', 'onclick', () => openDrawer(false));
    on('close', 'onclick', () => openDrawer(false));
    on('gear', 'onclick', () => { showSettings = !showSettings; sDraft = {}; render(); });
    on('msgx', 'onclick', () => { S.msg = ''; render(); });
    on('tobulk', 'onclick', () => { view = 'bulk'; showSettings = false; render(); });
    on('tosingle', 'onclick', () => { view = 'single'; showSettings = false; render(); });

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

    // run controls
    on('pause', 'onclick', () => { S.run.paused = !S.run.paused; render(); });
    on('cancel', 'onclick', cancelRun);
    on('resume', 'onclick', safeRun(resumeRun));
    on('rdiscard', 'onclick', discardResume);
    on('cursearch', 'onclick', safeRun(lookupReaderSearch));
    on('rcheck', 'onclick', safeRun(checkRecentUpdates));
    root.querySelectorAll('[data-upd]').forEach(b => b.onclick = () => { const r = S.recent[+b.dataset.upd]; if (!r) return; liText = recentUpdates(r).map(u => u.tips).join('\n'); S.single = null; lookup(); });

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
      sDraft = {}; await saveSettings(); setMsg(`Settings saved. Batch size is now ${bs}.`);
    });
    const FK = ['docJson', 'histCsv', 'histJson', 'attCsv', 'manifest'];
    const readFileBoxes = () => { for (const k of FK) if ($('f_' + k)) s.files[k] = $('f_' + k).checked; };
    for (const k of FK) on('f_' + k, 'onchange', async () => { readFileBoxes(); await saveSettings(); render(); });
    const preset = async p => { Object.assign(s.files, p); await saveSettings(); setMsg('File selection saved.'); };
    on('f_all', 'onclick', () => preset({ docJson: true, histCsv: true, histJson: true, attCsv: true, manifest: true }));
    on('f_csv', 'onclick', () => preset({ docJson: false, histCsv: true, histJson: false, attCsv: true, manifest: true }));
    on('f_json', 'onclick', () => preset({ docJson: true, histCsv: false, histJson: true, attCsv: false, manifest: false }));
    on('f_none', 'onclick', () => preset({ docJson: false, histCsv: false, histJson: false, attCsv: false, manifest: false }));
    on('s_check', 'onclick', () => { diag = checkSetup(); render(); });
    on('s_detect', 'onclick', async () => {
      detectSession(); await detectUserFallback();
      if (s.pageSizeSrc === 'manual') s.pageSizeSrc = 'default';
      notePageSize(+document.documentElement.dataset.tipsxPageSize);
      sDraft = {}; await saveSettings(); render();
    });

    if (focusLi && $('li') && !$('li').disabled) { $('li').focus(); $('li').setSelectionRange(selA, selB); }
    if (showSettings) for (const id of S_FIELDS) { const el = $(id); if (!el) continue; if (id in sDraft) el.value = sDraft[id]; el.addEventListener('input', () => { sDraft[id] = el.value; }); }
    root.querySelector('.body').scrollTop = scroll;
    if (focusOnOpen) { const t = $('li') && !$('li').disabled ? $('li') : root.querySelector('.dr ' + FOCUSABLE.split(',').join(',.dr ')); if (t) t.focus(); }
    syncToolbar();
  }
  const cancelRun = () => { if (S.run) { S.run.cancel = true; S.run.paused = false; } };
  function renderRunBox() {
    const box = visible && root.getElementById('runbox');
    if (box && S.run) { box.innerHTML = vSingleRun(S.run); }
    else renderProgress();
    syncRail(); syncToolbar();
  }
  function renderProgress() {
    const bar = root.getElementById('pbar'), lab = root.getElementById('plabel');
    if (bar && S.run && S.run.kind === 'bulk') bar.style.width = (100 * (S.run.i - 1) / S.run.total).toFixed(1) + '%';
    if (lab && S.run) lab.textContent = runLabel(S.run);
    syncRail();
  }

  // ---------------------------------------------------------------- Reader ⋮ menu entry + status badge on the ⋮ button
  // The menu (nav#auxMenu0-panel) is a CDK overlay rebuilt on every open; our item is re-added each time.
  const MENU_ICON = '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path>';
  function menuStatus() {
    if (S.run && S.run.kind === 'single') return `${Math.min(S.run.results.length + 1, S.run.total)} of ${S.run.total}…`;
    if (S.run) return `${S.run.title} · ${S.run.i}/${S.run.total}`;
    if (S.pending) return 'Ready to approve';
    if (S.resume) return 'Interrupted – resume';
    if (Date.now() < railFlash) return '✓ Saved';
    return '';
  }
  function closeAuxMenu() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    setTimeout(() => {   // fallback: toggle the trigger if the overlay ignored the synthetic Escape
      if (document.getElementById('auxMenu0-panel')) { const t = document.querySelector('#auxMenu0 button.xy-test-standard-trigger, #auxMenu0 button'); if (t) t.click(); }
    }, 60);
  }
  function injectMenu() {
    const nav = document.getElementById('auxMenu0-panel') || document.querySelector('nav.xy-c-aux-menu');
    if (!nav || nav.querySelector('.tipsx-menuitem')) return false;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xy-base-button xy-themed-state-transparent-primary xy-i-md xy-nowrap xy-position-relative tipsx-menuitem';
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `<span class="tipsx-mi-ic">${pageSvg(MENU_ICON, 24)}</span><span>TIPS Exporter</span><span class="tipsx-mi-st">${esc(menuStatus())}</span>`;
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); closeAuxMenu(); openDrawer(true); });
    const after = nav.querySelector('button.xy-i-cog'), before = nav.querySelector('button.xy-i-sign-out');
    if (after) after.after(b); else if (before) before.before(b); else nav.appendChild(b);
    return true;
  }
  function syncRail() {
    const aux = document.getElementById('auxMenu0') || document.querySelector('footer xy-c-aux-menu');
    const kind = !visible && S.run ? 'busy' : !visible && (S.pending || S.resume) ? 'wait' : Date.now() < railFlash ? 'done' : '';
    if (aux) {
      let bd = aux.querySelector(':scope > .tipsx-rbadge');
      if (!kind) { if (bd) bd.remove(); }
      else {
        if (!bd) { bd = document.createElement('span'); bd.className = 'tipsx-rbadge'; if (getComputedStyle(aux).position === 'static') aux.style.position = 'relative'; aux.appendChild(bd); }
        if (bd.dataset.kind !== kind) {
          bd.dataset.kind = kind;
          bd.innerHTML = kind === 'done' ? pageSvg('<path d="M20 6L9 17l-5-5"></path>', 12) : kind === 'wait' ? '!' : pageSvg(MENU_ICON, 12);
          bd.title = kind === 'done' ? 'TIPS Exporter: saved' : kind === 'wait' ? 'TIPS Exporter: batch ready to approve' : 'TIPS Exporter: downloading';
        }
      }
    }
    const st = document.querySelector('.tipsx-menuitem .tipsx-mi-st');
    if (st) { const t = menuStatus(); if (st.textContent !== t) st.textContent = t; }
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
  .tipsx-tip small{display:block;margin-top:2px;color:#bbb;font-size:11px}
  .tipsx-dl[aria-expanded=true]{background:#e8f1fd;color:#1f6fd1} .tipsx-dlwrap .tipsx-dl[aria-expanded=true]+.tipsx-tip{display:none}
  .tipsx-menuitem{display:flex;align-items:center;gap:8px;text-align:left}
  .tipsx-mi-ic{display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;flex:none}
  .tipsx-mi-st{margin-left:auto;padding-left:16px;font-size:12px;color:#006EFF}
  .tipsx-rbadge{position:absolute;top:4px;right:4px;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;display:flex;align-items:center;justify-content:center;
    background:#006EFF;color:#fff;font:700 11px/1 Arial,sans-serif;pointer-events:none;z-index:1}
  .tipsx-rbadge[data-kind=done]{background:#018601}
  .tipsx-row{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:2px;z-index:2}
  .tipsx-rdl:focus-visible{outline:2px solid #006EFF;outline-offset:2px}
  .tipsx-rdl{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:#595959;cursor:pointer;padding:0}
  .tipsx-rdl:hover,.tipsx-rdl[aria-expanded=true]{background:#e6f1ff;color:#006EFF} .tipsx-rdl[data-state=busy]{color:#006EFF;cursor:progress} .tipsx-rdl[data-state=done]{color:#018601} .tipsx-rdl[data-state=error]{color:#EA060A}`;
  const pageSvg = (d, n) => `<svg width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const TB_ICON = {
    idle: '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path>',
    busy: '<circle cx="12" cy="12" r="8" stroke-opacity=".25"></circle><path class="tipsx-spin" d="M12 4a8 8 0 0 1 8 8"></path>',
    done: '<path d="M20 6L9 17l-5-5"></path>',
    error: '<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>'
  };

  let otCache = { key: '', val: null }, idxById = { n: -1, map: null };
  function openTopic() {
    const m = location.pathname.match(ROUTE_RE); if (!m) return null;
    const tipsId = m[1], version = +m[2], key = location.pathname + '|' + S.index.length;
    if (otCache.key === key && otCache.val) return otCache.val;   // cheap on repeat calls while the same topic is open
    if (idxById.n !== S.index.length) idxById = { n: S.index.length, map: new Map(S.index.map(x => [String(x.tipsId), x])) };
    const ix = idxById.map.get(tipsId);
    const det = document.querySelector('neo-topic-detail'), h2 = det && det.querySelector('h2');
    let tips = ix && ix.tips;
    if (!tips && det) {   // the Title tab's "Topic number" row, else the first LI-shaped number in the dialog
      const lab = [...det.querySelectorAll('td, th, span, div, p')].find(el => el.childElementCount === 0 && el.textContent.trim() === 'Topic number');
      const row = lab && (lab.nextElementSibling || lab.parentElement.nextElementSibling);
      tips = ((row && row.textContent.match(LI_RE)) || det.textContent.match(LI_RE) || [])[0];
    }
    const val = tips ? { tips, tipsId: ix ? ix.tipsId : tipsId, routeId: tipsId, version, title: ix ? ix.title : (h2 ? h2.textContent.trim() : '') } : null;
    otCache = { key, val };
    return val;
  }
  function tipHtml() {
    if (tb.state === 'busy') return `Downloading${S.run && S.run.kind === 'single' ? ' – ' + esc(runLabel(S.run)) : '…'}<small>TIPS Exporter</small>`;
    if (tb.state !== 'idle') return `${esc(tb.msg)}<small>TIPS Exporter</small>`;
    const t = openTopic();
    return `Download ${t ? esc(t.tips) : 'this topic'} – choose versions and attachments<small>TIPS Exporter</small>`;
  }
  function syncToolbar() {
    for (const b of document.querySelectorAll('button.tipsx-dl')) {
      if (b.dataset.state !== tb.state) {
        b.dataset.state = tb.state;
        b.innerHTML = pageSvg(TB_ICON[tb.state], +b.dataset.icon || 22) + '<span class="tipsx-dot"></span>';
        b.setAttribute('aria-busy', String(tb.state === 'busy'));
        if (tb.state === 'done' || tb.state === 'error') b.parentElement.setAttribute('data-show', ''); else b.parentElement.removeAttribute('data-show');
      }
      const tip = b.nextElementSibling;
      if (!tip || (tb.state === 'idle' && tip.innerHTML && !b.parentElement.matches(':hover') && document.activeElement !== b)) continue;
      const html = tipHtml();
      if (tip.innerHTML !== html) tip.innerHTML = html;
    }
  }
  async function downloadOpenTopic(anchor) {
    if (tb.state === 'busy') return;
    if (pick) { const same = pick.anchor === anchor; closePick(null); if (same) return; }   // the button toggles its picker
    const settle = (state, msg, ms) => { tb.state = state; tb.msg = msg; syncToolbar(); setTimeout(() => { if (tb.state === state) { tb.state = 'idle'; syncToolbar(); } }, ms); };
    const t = openTopic();
    if (!t) return settle('error', "Couldn't tell which topic is open – use the panel instead.", 6000);
    if (S.resume) return settle('error', 'A download was interrupted – open TIPS Exporter to resume or discard it first.', 6000);
    if (S.pending || (S.run && S.run.kind === 'bulk')) return settle('error', 'A bulk batch is running or waiting for approval – finish or discard it first.', 6000);
    if (S.run || (S.single && S.single.phase === 'looking')) return settle('error', 'Another download is running – wait for it to finish.', 6000);
    if (!sessionOK()) return settle('error', 'Session not detected – open the panel and check ⚙ Settings.', 6000);
    // Keep a list the user looked up in the panel; it comes back after this download.
    const keep = S.single && S.single.phase === 'looked' ? { single: S.single, liText } : null;
    const restore = () => { if (keep) { S.single = keep.single; liText = keep.liText; } };
    tb.state = 'busy'; tb.msg = ''; S.single = { phase: 'looking' }; syncToolbar(); render();   // 'looking' also locks the panel's Look up
    const msg0 = S.msg;
    try {
      const hit = await searchByNumber(t.tips.toUpperCase());   // current version, live from TIPS
      // Never download a different topic than the one open: the LI number must belong to the topic in the address.
      if (hit && String(hit.tipsId) !== String(t.routeId)) { S.single = null; restore(); return settle('error', `${t.tips} is not the topic that's open – use the panel instead.`, 6000); }
      if (S.run || S.pending) { S.single = null; restore(); return settle('error', 'Another download started – try again when it finishes.', 6000); }
      const item = hit || { tips: t.tips, tipsId: t.routeId, version: t.version, title: t.title };
      // pick versions / attachments; nothing is locked while the picker is open
      S.single = null; restore(); tb.state = 'idle'; syncToolbar(); render();
      const opts = await chooseDownload(item, anchor);
      if (!opts) return;
      if (busy() || (S.single && S.single.phase === 'looking')) return settle('error', 'Another download started – try again when it finishes.', 6000);
      tb.state = 'busy'; syncToolbar();
      S.single = { phase: 'looked', found: [{ ...item, version: opts.doc.version || item.version, opts }], problems: [] };
      await downloadFound();
      if (S.single && S.single.phase === 'done') {
        const m = S.single.sum, fname = S.single.fname;
        settle('done', `Saved ${fname} (${m.sizeMB} MB)${m.errors.length ? ` – ${m.errors.length} file(s) could not be saved, see _errors.txt in the zip` : ''}`, 5000);
        if (keep) restore();
      } else { restore(); settle('error', S.msg !== msg0 && S.msg ? S.msg : 'Download stopped – nothing saved.', 6000); }
    } catch (e) { S.single = null; restore(); settle('error', e.message, 6000); }
    render();
  }
  function injectToolbar() {
    injectQueued = false;
    if (!document.getElementById('tipsx-page-css')) {
      const st = document.createElement('style'); st.id = 'tipsx-page-css'; st.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    let added = false;
    for (const print of document.querySelectorAll('neo-topic-detail button.xy-i-print')) {
      const anchor = print.closest('xy-c-spinner') || print.parentElement;
      if (!anchor || !anchor.parentElement || anchor.parentElement.querySelector(':scope > .tipsx-dlwrap')) continue;
      const r = print.getBoundingClientRect(), w = Math.round(r.width) || 40, h = Math.round(r.height) || w;
      const wrap = document.createElement('div'); wrap.className = 'tipsx-dlwrap';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tipsx-dl'; b.style.width = w + 'px'; b.style.height = h + 'px';
      b.dataset.icon = Math.round(Math.min(w, h) * .6);
      b.setAttribute('aria-label', 'Download this topic – choose versions (TIPS Exporter)'); b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', 'false');
      b.style.setProperty('--tipsx-fg', getComputedStyle(print).color);
      const tip = document.createElement('div'); tip.className = 'tipsx-tip'; tip.setAttribute('role', 'tooltip');
      wrap.append(b, tip);
      anchor.after(wrap);
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); downloadOpenTopic(b); });
      wrap.addEventListener('mouseenter', syncToolbar);
      added = true;
    }
    if (injectMenu()) added = true;
    if (injectRows()) added = true;
    if (added) { syncToolbar(); syncRail(); syncRows(); }
  }
  // Each topic in the search results is a card <xy-c-card-table-card id="card-<topicId>_<version>_P"> holding one big button.
  // Our controls sit beside that button (not inside it) at the right edge of the card.
  const ROW_RE = /^card-(\d+)_(\d+)_P$/, rowState = {};
  function injectRows() {
    let added = false;
    for (const card of document.querySelectorAll('xy-c-card-table-card[id^="card-"]')) {
      const m = card.id.match(ROW_RE), btn = card.querySelector(':scope > button');
      if (!m || !btn || card.querySelector(':scope > .tipsx-row')) continue;
      const cols = btn.querySelectorAll('xy-c-card-column');
      const tips = ((cols[0] && cols[0].textContent.match(LI_RE)) || btn.textContent.match(LI_RE) || [])[0];
      if (!tips) continue;
      const item = { tips, tipsId: m[1], version: +m[2], title: cols[1] ? cols[1].textContent.trim() : '' };
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      btn.style.paddingRight = '56px';
      const box = document.createElement('div');
      box.className = 'tipsx-row'; box.dataset.tipsId = item.tipsId;
      box.innerHTML = `<button type="button" class="tipsx-rdl" aria-label="Download ${esc(tips)} – choose versions" aria-haspopup="dialog" aria-expanded="false" title="Download ${esc(tips)} – choose versions and attachments (TIPS Exporter)"></button>`;
      const dl = box.querySelector('.tipsx-rdl');
      box.addEventListener('click', e => e.stopPropagation());
      dl.addEventListener('click', e => { e.preventDefault(); downloadRow(item, dl); });
      card.appendChild(box); added = true;
    }
    return added;
  }
  function syncRows() {
    for (const box of document.querySelectorAll('.tipsx-row')) {
      const id = box.dataset.tipsId, st = rowState[id] || 'idle', dl = box.querySelector('.tipsx-rdl');
      if (dl.dataset.state !== st) { dl.dataset.state = st; dl.innerHTML = pageSvg(TB_ICON[st], 20); }
    }
  }
  async function downloadRow(item, anchor) {
    if (rowState[item.tipsId] === 'busy') return;
    if (pick) { const same = pick.item.tipsId === item.tipsId; closePick(null); if (same) return; }   // the icon toggles its picker
    const flash = (st, ms) => { rowState[item.tipsId] = st; syncRows(); setTimeout(() => { if (rowState[item.tipsId] === st) { delete rowState[item.tipsId]; syncRows(); } }, ms); };
    const blocked = () => busy() || (S.single && S.single.phase === 'looking');
    if (blocked()) { setMsg('Finish, resume or discard the current download first.'); return flash('error', 4000); }
    if (!sessionOK()) { setMsg('Session values missing – open ⚙ Settings.'); return flash('error', 4000); }
    const opts = await chooseDownload(item, anchor);
    if (!opts) return;
    if (blocked()) { setMsg('Finish, resume or discard the current download first.'); return flash('error', 4000); }
    const keep = S.single && S.single.phase === 'looked' ? { single: S.single, liText } : null;
    rowState[item.tipsId] = 'busy'; syncRows();
    S.single = { phase: 'looked', found: [{ ...item, version: opts.doc.version || item.version, opts }], problems: [] };
    try {
      await downloadFound();
      if (S.single && S.single.phase === 'done') { flash('done', 5000); if (keep) { S.single = keep.single; liText = keep.liText; } }
      else flash('error', 6000);
    } catch (e) { flash('error', 6000); setMsg((e instanceof SessionError ? '⚠ ' : 'Error: ') + e.message); }
    render();
  }
  // Row download picker: a small TIPS-styled popup under the row's icon listing every version of the topic
  // (newest first, with its date and change reason; the current one ticked) and whether to include attachments. Resolves with the
  // choice {versions, att, allVers, dropAtt, doc} or null when closed.
  const pickHost = document.createElement('div');
  pickHost.style.cssText = host.style.cssText;
  const proot = pickHost.attachShadow({ mode: 'open' });
  let pick = null;   // {item, anchor, doc, err, vers: [{v, date, why}], sel: Set, att, resolve}
  const fmtDate = d => { if (d == null || d === '') return ''; const t = new Date(/^\d+$/.test(String(d)) ? +d : d); return isNaN(t) ? String(d).slice(0, 10) : t.toLocaleDateString(); };
  // Dates come from the revision history (the Published step). The change reason is part of each version's own
  // topic data, so only the current one is known without another request per version; history entries are the fallback.
  function versionList(doc, cur) {
    const hist = (doc.history && doc.history.children) || [], out = [];
    for (let n = cur; n >= 1; n--) {
      const hs = hist.filter(h => +h.version === n), h = hs.find(x => x.flowId === 'PUB') || hs[hs.length - 1];
      const why = ((n === cur && loc(doc.i18nChangeReason)) || hs.map(x => loc(x.i18nChangeReason)).find(Boolean) || '').replace(/\s+/g, ' ').trim();
      out.push({ v: n, date: h ? fmtDate(h.creationDate) : '', why });
    }
    return out;
  }
  function chooseDownload(item, anchor) {
    return new Promise(resolve => {
      if (!pickHost.isConnected) document.documentElement.appendChild(pickHost);
      pick = { item, anchor, doc: null, err: '', vers: [], sel: new Set(), att: true, resolve };
      if (anchor) anchor.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', pickOutside, true);
      window.addEventListener('keydown', pickKey, true);
      window.addEventListener('resize', placePick); window.addEventListener('scroll', placePick, true);
      renderPick('p_x');
      const mine = () => pick && pick.item === item;
      get(`/tips/topic-service/api/v1/topics/${item.tipsId}/${item.version}?${Q()}`, 'application/json')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(doc => { if (!mine()) return; pick.doc = doc; pick.vers = versionList(doc, doc.version || item.version); pick.sel = new Set([pick.vers[0].v]); renderPick('p_go'); })
        .catch(e => { if (!mine()) return; pick.err = e instanceof SessionError ? `⚠ ${e.message} – log in to XENTRY again, then try once more.` : 'Could not read the versions: ' + e.message; renderPick('p_x'); });
    });
  }
  function closePick(result) {
    const p = pick; if (!p) return;
    pick = null; proot.innerHTML = '';
    document.removeEventListener('pointerdown', pickOutside, true);
    window.removeEventListener('keydown', pickKey, true);
    window.removeEventListener('resize', placePick); window.removeEventListener('scroll', placePick, true);
    if (p.anchor) { p.anchor.setAttribute('aria-expanded', 'false'); if (p.anchor.isConnected) p.anchor.focus(); }
    p.resolve(result);
  }
  function pickOutside(e) { const path = e.composedPath(); if (pick && !path.includes(pickHost) && !path.includes(pick.anchor)) closePick(null); }
  function pickKey(e) {
    if (!pick) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closePick(null); return; }
    if (e.key === 'Tab') {   // keep focus inside the popup
      const f = [...proot.querySelectorAll(FOCUSABLE)], a = proot.activeElement;
      if (!f.length) return;
      if (e.shiftKey && (a === f[0] || !a)) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && (a === f.at(-1) || !a)) { e.preventDefault(); f[0].focus(); }
    }
  }
  function placePick() {
    const el = proot.querySelector('.pk'); if (!el || !pick) return;
    const a = pick.anchor && pick.anchor.isConnected ? pick.anchor.getBoundingClientRect() : null;
    const w = el.offsetWidth, h = el.offsetHeight, W = window.innerWidth, Hh = window.innerHeight;
    let left = a ? a.right - w : (W - w) / 2, top = a ? a.bottom + 4 : (Hh - h) / 2;
    if (a && top + h > Hh - 8) top = Math.max(8, a.top - 4 - h);
    el.style.left = Math.round(Math.min(Math.max(16, left), W - w - 16)) + 'px'; el.style.top = Math.round(Math.max(8, top)) + 'px';
  }
  function renderPick(focusId) {
    const p = pick; if (!p) return;
    const it = p.item, d = p.doc, atts = d ? (d.attachments || []).length : 0, refs = d ? (d.references || []).length : 0;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    let body;
    if (p.err) body = `<div class="ban er"><div class="bd sm">${esc(p.err)}</div></div>`;
    else if (!d) body = `<div class="ld sm mut"><span class="acc spin">${svg('<circle cx="12" cy="12" r="8" stroke-opacity=".25"></circle><path d="M12 4a8 8 0 0 1 8 8"></path>', 16, 2.4)}</span>Reading versions…</div>`;
    else body = `<div class="sp"><b>Versions</b><span class="sm"><button class="lk" id="p_all">All</button> · <button class="lk" id="p_cur">Current only</button></span></div>
      <div class="vl" role="group" aria-label="Versions">${p.vers.map((x, i) => `<label class="ck vr"><input type="checkbox" data-v="${x.v}" ${p.sel.has(x.v) ? 'checked' : ''}>
        <span class="bd"><span class="l1"><span>v${x.v}</span>${i === 0 ? '<span class="tag">current</span>' : ''}<span class="mut sm dt">${esc(x.date)}</span></span>
        ${x.why ? `<span class="mut sm one" title="${esc(x.why)}">${esc(x.why)}</span>` : ''}</span></label>`).join('')}</div>
      ${atts + refs ? `<label class="ck"><input type="checkbox" id="p_att" ${p.att ? 'checked' : ''}> Include ${atts && refs ? 'attachments and links' : atts ? 'attachments' : 'the links list'} <span class="mut sm">(${[atts && plural(atts, 'file'), refs && plural(refs, 'link')].filter(Boolean).join(', ')})</span></label>`
        : '<span class="mut sm">This topic has no attachments or links.</span>'}`;
    proot.innerHTML = `<style>${css}</style><div class="pk" role="dialog" aria-modal="false" aria-label="Download ${esc(it.tips)}">
      <div class="phd"><div class="bd"><b>Download ${esc(it.tips)}</b><span class="mut sm one" title="${esc(it.title)}">${esc(it.title)}</span></div>
        <button class="ib" id="p_x" aria-label="Close">${svg('<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>', 20, 1.5)}</button></div>
      <div class="pbd">${body}</div>
      <div class="pft"><button class="b bar" id="p_cancel">Cancel</button><button class="b pri" id="p_go" ${d ? '' : 'disabled'}>${I.dl}<span id="p_n"></span></button></div></div>`;
    const $ = id => proot.getElementById(id), go = $('p_go');
    const upd = () => {
      const n = p.sel.size;
      go.disabled = !d || !n;
      $('p_n').textContent = !d ? 'Download' : !n ? 'Pick a version' : n === p.vers.length ? `Download all ${plural(n, 'version')}` : `Download ${plural(n, 'version')}`;
    };
    const setAll = vs => { p.sel = new Set(vs); for (const cb of proot.querySelectorAll('input[data-v]')) cb.checked = p.sel.has(+cb.dataset.v); upd(); };
    $('p_x').onclick = $('p_cancel').onclick = () => closePick(null);
    if (d) {
      for (const cb of proot.querySelectorAll('input[data-v]')) cb.onchange = () => { if (cb.checked) p.sel.add(+cb.dataset.v); else p.sel.delete(+cb.dataset.v); upd(); };
      $('p_all').onclick = () => setAll(p.vers.map(x => x.v));
      $('p_cur').onclick = () => setAll([p.vers[0].v]);
      if ($('p_att')) $('p_att').onchange = e => { p.att = e.target.checked; };
      go.onclick = () => { if (!p.sel.size) return; const versions = [...p.sel].sort((a, b) => a - b);
        closePick({ versions, att: !!(p.att && atts + refs), allVers: versions.length === p.vers.length, dropAtt: !p.att && atts + refs > 0, doc: d }); };
    }
    upd(); placePick();
    const f = focusId && $(focusId); if (f && !f.disabled) f.focus();
  }
  let injectQueued = false;
  new MutationObserver(muts => {
    if (injectQueued || muts.every(m => m.target.closest && m.target.closest('.tipsx-dlwrap, .tipsx-rbadge, .tipsx-menuitem, .tipsx-row'))) return;   // ignore our own updates
    injectQueued = true; requestAnimationFrame(injectToolbar);
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('beforeunload', e => { if (S.run || S.pending || S.resume) { e.preventDefault(); e.returnValue = ''; } });
  if (hasChrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((m, _s, reply) => { if (m && m.type === 'toggle') openDrawer(!visible); reply && reply(true); });
  }

  if (!hasChrome) window.__TIPSX_DEBUG = { S, importLog, prepareBatch, approve, discard, render, progressCsv, nextBatch, lookupSpecific, downloadFound, downloadOpenTopic };

  document.documentElement.appendChild(host);
  load().then(async () => { if (!S.settings.user) await detectUserFallback(); await saveSettings(); render(); });
  // Late detection: the Reader fires its first API calls after load
  setTimeout(() => { if (!sessionOK()) { detectSession(); saveSettings(); render(); } }, 5000);
})();
