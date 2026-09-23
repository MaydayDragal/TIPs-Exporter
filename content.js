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
    settings: { outlet: '', user: '', ver: '', batchSize: 25, delayMs: 250, autoApprove: false, autoContinue: true,
      files: { docJson: true, attCsv: true, histCsv: true, histJson: true, manifest: true } },
    run: null,          // {n, i, total, label, paused, cancel}
    pending: null,      // prepared batch awaiting approval {n, blob, fname, summary, results}
    msg: ''
  };
  const DEFAULT_SEARCH = { fuzzyActive: true, correlationId: 4, fallbackLang: 'en', area: 'WS', creator: null, sortorder: { field: 'mdate', order: 'desc' }, lang: { lang: 'en' }, countries: ['US'], vehicleContext: {}, timefilter: {}, docName: '', workstate: '', brandNames: ['Maybach', 'Mercedes-Benz'], productGroupNames: ['PKW', 'Supersportwagen'], pagination: { pageNumber: 1, pageSize: 500 }, drilldowns: [{ key: 'country', identifier: 'US' }], favFilterActive: false, searchField: 'all', provideNavigation: 'full', totalHitsCountOnly: false, useAi: false };

  async function load() {
    S.index = await store.get('index', []);
    S.done = await store.get('done', {});
    S.history = await store.get('history', []);
    const saved = await store.get('settings', {});
    S.settings = { ...S.settings, ...saved, files: { ...S.settings.files, ...(saved.files || {}) } };
    detectSession();
  }
  const saveIndex = () => store.set('index', S.index);
  const saveDone = () => store.set('done', S.done);
  const saveHistory = () => store.set('history', S.history);
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
  async function searchAll(sortorder) {
    const out = []; let total = 0;
    for (let p = 1; p <= 20; p++) {
      const r = await fetch('/tips/topic-service/api/v1/topics/search?' + Q(), { method: 'POST', credentials: 'include', headers: H(), body: JSON.stringify({ ...DEFAULT_SEARCH, sortorder, pagination: { pageNumber: p, pageSize: 500 } }) });
      if (r.status === 401 || r.status === 403) throw new SessionError('Session expired (HTTP ' + r.status + ')');
      if (!r.ok) throw new Error('Search failed: HTTP ' + r.status);
      const j = await r.json(); total = j.totalHits;
      if (!j.hits || !j.hits.length) break;
      for (const h of j.hits) out.push({ tips: h.tips, tipsId: h.tipsId, version: h.version, title: h.title, mdate: h.modificationDate });
      if (p * 500 >= total) break;
      await sleep(300);
    }
    return { out, total };
  }
  async function fetchAllTopics() {
    const m = new Map(); let total = 0;
    for (const so of [{ field: 'mdate', order: 'desc' }, { field: 'mdate', order: 'asc' }]) {
      const r = await searchAll(so); total = r.total;
      for (const x of r.out) if (!m.has(x.tipsId)) m.set(x.tipsId, x);
    }
    return { list: [...m.values()], total };
  }
  async function buildIndex() {
    if (S.index.length && !confirm('An index already exists. Rebuilding re-sorts everything and can shift batch numbers. Use "Check for new/updated" instead unless you are starting over.\n\nRebuild anyway?')) return;
    setMsg('Building index…');
    const { list, total } = await fetchAllTopics();
    S.index = list.sort((a, b) => a.tips.localeCompare(b.tips));
    await saveIndex();
    setMsg(`Index built: ${S.index.length} unique topics (${total} search hits), ${remainingBatches()} batches to go at ${S.settings.batchSize} per batch.`);
  }
  async function refreshIndex() {
    setMsg('Checking for new or updated topics…');
    const { list } = await fetchAllTopics();
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
    setMsg(`${fresh.length} new topic(s) appended at the end; ${updated} topic(s) have a newer version` + (reexport ? ` (${reexport} already-exported one(s) re-queued)` : '') + '.');
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
    step('topic data');
    const jr = await get(`/tips/topic-service/api/v1/topics/${item.tipsId}/${item.version}?${Q()}`, 'application/json');
    if (!jr.ok) throw new Error('topic data HTTP ' + jr.status);
    const doc = await jr.json();
    const v = doc.version || item.version;
    const F = S.settings.files;
    if (F.docJson) files.push({ name: `${base}/${safe(item.tips)}_v${v}.json`, data: txt(JSON.stringify(doc, null, 2)) });

    step(`PDF v${v}`);
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
        step(`attachment ${k + 1}/${atts.length}`);
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
      step(`prior version v${pv}`);
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
  async function runDocs(title, items) {
    S.run = { title, i: 0, total: items.length, label: '', paused: false, cancel: false };
    render();
    const files = [], errors = [], results = [];
    try {
      for (const it of items) {
        while (S.run.paused && !S.run.cancel) await sleep(400);
        if (S.run.cancel) throw new Error('cancelled');
        S.run.i++; S.run.label = it.tips; render();
        try {
          const r = await exportDoc(it, files, errors, s => { S.run.label = `${it.tips} – ${s}`; renderProgress(); });
          results.push({ ...it, ...r, status: 'ok' });
        } catch (e) {
          if (e instanceof SessionError) throw e;
          results.push({ ...it, status: 'FAILED: ' + e.message }); errors.push(`${it.tips}: ${e.message}`);
        }
        await sleep(S.settings.delayMs);
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
    const out = await runDocs(`Batch ${n}`, items);
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
  async function resolveNumbers(text) {
    const tokens = [...new Set(text.split(/[\s,;]+/).map(t => t.trim().toUpperCase()).filter(Boolean))];
    const found = [], problems = [];
    for (const t of tokens) {
      let no = FULL_NO.test(t) ? t : null;
      if (!no) {
        const m = S.index.filter(x => x.tips.toUpperCase().includes(t));
        if (m.length === 1) no = m[0].tips.toUpperCase();
        else { problems.push(m.length ? `${t}: matches ${m.length} topics (${m.slice(0, 3).map(x => x.tips).join(', ')}${m.length > 3 ? '…' : ''}) – be more specific` : `${t}: not found${S.index.length ? '' : ' (enter the full number, e.g. LI42.10-P-078779, or build the index first)'}`); continue; }
      }
      const hit = await searchByNumber(no);           // always fetch the CURRENT version from TIPS
      if (hit) { if (!found.some(f => f.tipsId === hit.tipsId)) found.push(hit); }
      else problems.push(`${no}: not found in TIPS search`);
    }
    return { found, problems };
  }
  async function downloadSpecific(text) {
    if (S.run || S.pending) { setMsg('Finish or discard the current batch first.'); return; }
    if (!sessionOK()) { setMsg('Session values missing – open ⚙ Settings.'); return; }
    if (!text.trim()) { setMsg('Enter one or more LI numbers.'); return; }
    setMsg('Looking up…');
    const { found, problems } = await resolveNumbers(text);
    if (!found.length) { setMsg('Nothing to download. ' + problems.join(' | ')); return; }
    const out = await runDocs(found.length === 1 ? found[0].tips : `${found.length} documents`, found);
    if (!out) return;
    const { files, errors, results } = out;
    if (S.settings.files.manifest) files.unshift({ name: `_manifest.csv`, data: txt(manifestCsv(results)) });
    if (errors.length || problems.length) files.unshift({ name: `_errors.txt`, data: txt([...problems, ...errors].join('\r\n')) });
    const blob = makeZip(files);
    const fname = found.length === 1 ? `TIPS_${safe(found[0].tips)}.zip` : `TIPS_selection_${new Date().toISOString().slice(0, 10)}_${found.length}docs.zip`;
    saveBlob(blob, fname);   // explicit request -> download straight away; does not change bulk-export progress
    const s = summarize(fname, blob, results, errors);
    setMsg(`Downloaded ${fname} (${s.sizeMB} MB): ${s.ok}/${s.docs} docs, ${s.att} attachments, ${s.prev} prior versions` + (errors.length ? `, ${errors.length} error(s)` : '') + (problems.length ? '. Skipped: ' + problems.join(' | ') : '.'));
  }

  // ---------------------------------------------------------------- UI
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'open' });
  let visible = false, showSettings = false, liText = '';
  const css = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .fab{background:#111;color:#fff;border:0;border-radius:20px;padding:9px 14px;font-size:13px;cursor:grab;box-shadow:0 2px 8px rgba(0,0,0,.3);user-select:none}
  .panel{width:400px;max-height:calc(100vh - 24px);overflow:auto;background:#fff;color:#1a1a1a;border:1px solid #ccc;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;background:#111;color:#fff;padding:10px 12px;position:sticky;top:0;cursor:grab;user-select:none;z-index:1}
  header.dragging,.fab.dragging{cursor:grabbing}
  header b{font-size:14px} header .grip{opacity:.6;margin-right:6px;letter-spacing:-2px}
  header button{background:none;border:0;color:#fff;font-size:16px;cursor:pointer;padding:0 4px}
  section{padding:10px 12px;border-bottom:1px solid #eee}
  h4{margin:0 0 6px;font-size:13px}
  .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;text-align:center}
  .stat{background:#f4f5f7;border-radius:6px;padding:6px}.stat b{display:block;font-size:17px}
  button.b{border:1px solid #bbb;background:#fafafa;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
  button.b:hover{background:#eee} button.b:disabled{opacity:.45;cursor:default}
  button.p{background:#0a64d6;color:#fff;border-color:#0a64d6} button.p:hover{background:#0853b3}
  button.g{background:#1f8a4c;color:#fff;border-color:#1f8a4c} button.g:hover{background:#18703d} button.r{color:#b3261e}
  .bar{height:8px;background:#e6e6e6;border-radius:4px;overflow:hidden;margin:6px 0}.bar i{display:block;height:100%;background:#0a64d6}
  .muted{color:#666;font-size:12px} .ok{color:#1f8a4c} .warn{color:#b3261e}
  .card{background:#f4f8ff;border:1px solid #cfe0fb;border-radius:8px;padding:8px}
  table{width:100%;border-collapse:collapse;font-size:12px} td,th{padding:3px 4px;border-bottom:1px solid #eee;text-align:left}
  label{display:flex;gap:6px;align-items:center;font-size:12px;margin:3px 0}
  input[type=text],input[type=number]{border:1px solid #bbb;border-radius:5px;padding:4px 6px;font-size:12px;width:130px}
  textarea{width:100%;border:1px solid #bbb;border-radius:5px;padding:6px;font-size:12px;font-family:ui-monospace,Consolas,monospace;resize:vertical;min-height:34px}
  details summary{cursor:pointer;font-size:12px} pre{white-space:pre-wrap;font-size:11px;max-height:120px;overflow:auto;background:#fafafa;padding:6px;border-radius:5px}
  .fgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 8px} code{font-size:11px;background:#f0f0f0;padding:0 3px;border-radius:3px}
  .msg{background:#fffbe6;border:1px solid #f0e2a0;border-radius:6px;padding:6px 8px;font-size:12px}`;
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

  function render() {
    if (!visible) {
      root.innerHTML = `<style>${css}</style><div class="fab" id="open" title="Click to open · drag to move">⬇ TIPS Exporter</div>`;
      const fab = root.getElementById('open');
      fab.onpointerdown = e => startDrag(e, fab, () => { visible = true; render(); });
      placeHost(); return;
    }
    const dc = doneCount(), nb = nextBatch(), s = S.settings, run = S.run, pen = S.pending, pendN = pendingItems().length;
    const pct = S.index.length ? (100 * dc / S.index.length) : 0;
    root.innerHTML = `<style>${css}</style><div class="panel">
      <header id="hdr" title="Drag to move · double-click to reset position"><b><span class="grip">⋮⋮</span>TIPS Exporter</b><span><button id="gear" title="Settings">⚙</button><button id="min" title="Minimise">–</button></span></header>
      <section>
        <div class="muted">Session: ${sessionOK() ? `<span class="ok">✓</span> user ${esc(s.user)} · outlet ${esc(s.outlet)} · Reader v${esc(s.ver)}` : '<span class="warn">✗ not detected – open any topic once, or set it in ⚙</span>'}</div>
        <div class="stats" style="margin-top:8px">
          <div class="stat"><b>${S.index.length || '—'}</b>topics</div>
          <div class="stat"><b>${dc}</b>exported</div>
          <div class="stat"><b>${nb ?? (S.index.length ? 'done' : '—')}</b>next batch</div>
        </div>
        <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="muted">${pct.toFixed(1)}% · ${pendN} pending · ${s.batchSize} per batch · ~${remainingBatches()} batches left</div>
      </section>
      ${S.msg ? `<section><div class="msg">${esc(S.msg)}</div></section>` : ''}
      ${showSettings ? `<section>
        <h4>Settings</h4>
        <label>Batch size <input type="number" id="s_bs" value="${s.batchSize}" min="1" max="500" style="width:70px"> <span class="muted">documents per zip</span></label>
        <label>Delay between docs (ms) <input type="number" id="s_delay" value="${s.delayMs}" min="0" step="50" style="width:70px"></label>
        <label>Outlet <input type="text" id="s_outlet" value="${esc(s.outlet)}"></label>
        <label>User <input type="text" id="s_user" value="${esc(s.user)}"></label>
        <label>Reader version <input type="text" id="s_ver" value="${esc(s.ver)}"></label>
        <div style="margin:8px 0 2px;font-size:12px;font-weight:600">Data files to include <span class="muted" style="font-weight:400">(PDFs and attachments are always saved)</span></div>
        <div class="fgrid">
          <label><input type="checkbox" id="f_docJson" ${s.files.docJson ? 'checked' : ''}> Document data <code>.json</code></label>
          <label><input type="checkbox" id="f_histCsv" ${s.files.histCsv ? 'checked' : ''}> Revision history <code>.csv</code></label>
          <label><input type="checkbox" id="f_histJson" ${s.files.histJson ? 'checked' : ''}> Revision history <code>.json</code></label>
          <label><input type="checkbox" id="f_attCsv" ${s.files.attCsv ? 'checked' : ''}> Attachments &amp; links list <code>.csv</code></label>
          <label><input type="checkbox" id="f_manifest" ${s.files.manifest ? 'checked' : ''}> Batch manifest <code>.csv</code></label>
          <label title="Always included – needed to resume"><input type="checkbox" checked disabled> Progress log <code>.csv</code></label>
        </div>
        <div class="row" style="margin:2px 0 6px"><button class="b" id="f_all">All</button><button class="b" id="f_csv">CSV only</button><button class="b" id="f_json">JSON only</button><button class="b" id="f_none">None</button></div>
        ${!s.files.attCsv ? '<div class="muted warn" style="margin-bottom:4px">Note: links (references to other LIs) are only recorded in the attachments &amp; links CSV.</div>' : ''}
        <div class="muted" style="margin:4px 0">Batch size can be changed any time; progress is tracked per document, so nothing is skipped or repeated.</div>
        <div class="row"><button class="b p" id="s_save">Save</button><button class="b" id="s_detect">Re-detect session</button><button class="b" id="s_pos">Reset panel position</button></div>
      </section>` : ''}
      <section>
        <h4>Download specific LI</h4>
        <textarea id="li" rows="2" placeholder="LI42.10-P-078779&#10;one or more, separated by spaces, commas or new lines" ${run ? 'disabled' : ''}>${esc(liText)}</textarea>
        <div class="row" style="margin-top:6px"><button class="b p" id="lidl" ${run || pen ? 'disabled' : ''}>Download with revisions, attachments &amp; links</button></div>
        <div class="muted" style="margin-top:4px">Always pulls the current version from TIPS. Saved as TIPS_&lt;LI&gt;.zip and does not affect bulk progress. A unique fragment (e.g. 078779) works once the index is built.</div>
      </section>
      <section>
        <h4>Bulk export</h4>
        ${run ? `<b>${esc(run.title)}</b> – document ${run.i}/${run.total} ${run.paused ? '<span class="warn">(paused)</span>' : ''}
          <div class="bar"><i id="pbar" style="width:${(100 * (run.i - 1) / run.total).toFixed(1)}%"></i></div>
          <div class="muted" id="plabel">${esc(run.label)}</div>
          <div class="row" style="margin-top:6px"><button class="b" id="pause">${run.paused ? 'Resume' : 'Pause'}</button><button class="b r" id="cancel">Cancel</button></div>`
        : pen ? `<div class="card"><b>${esc(pen.summary.fname)}</b><br>
            ${pen.summary.sizeMB} MB · ${pen.summary.ok}/${pen.summary.docs} docs · ${pen.summary.att} attachments · ${pen.summary.prev} prior versions<br>
            <span class="muted">${esc(pen.summary.range)}</span><br>
            ${pen.summary.errors.length ? `<details><summary class="warn">${pen.summary.errors.length} error(s)</summary><pre>${esc(pen.summary.errors.join('\n'))}</pre></details>` : '<span class="ok">No errors</span>'}
            <div class="row" style="margin-top:8px"><button class="b g" id="approve">Approve &amp; download</button><button class="b" id="discard">Discard</button></div></div>`
        : `<div class="row"><button class="b p" id="prep" ${!S.index.length || !nb ? 'disabled' : ''}>Prepare batch ${nb ?? ''} (next ${Math.min(s.batchSize, pendN)} docs)</button></div>`}
        <label><input type="checkbox" id="autoc" ${s.autoContinue ? 'checked' : ''}> After download, start preparing the next batch</label>
        <label><input type="checkbox" id="autoa" ${s.autoApprove ? 'checked' : ''}> Auto-approve (download without asking)</label>
      </section>
      <section>
        <div class="row">
          <button class="b" id="build" ${run ? 'disabled' : ''}>${S.index.length ? 'Rebuild index' : 'Build index'}</button>
          <button class="b" id="refresh" ${!S.index.length || run ? 'disabled' : ''}>Check for new/updated</button>
          <button class="b" id="imp" ${run ? 'disabled' : ''}>Import log…</button>
          <button class="b" id="exp" ${!S.index.length ? 'disabled' : ''}>Save log CSV</button>
          <input type="file" id="file" accept=".csv" style="display:none">
        </div>
      </section>
      ${S.history.length ? `<section><details><summary>Batch history (${S.history.length} in this browser)</summary>
        <table><tr><th>#</th><th>Size</th><th>Docs</th><th>Att.</th><th>Prev.</th><th>Err.</th></tr>
        ${S.history.slice().reverse().map(h => `<tr><td>${h.n}</td><td>${h.sizeMB} MB</td><td>${h.ok}/${h.docs}</td><td>${h.att}</td><td>${h.prev}</td><td>${h.errors}</td></tr>`).join('')}</table></details></section>` : ''}
    </div>`;
    const $ = id => root.getElementById(id);
    const safeRun = fn => async () => { try { await fn(); } catch (e) { S.run = null; setMsg((e instanceof SessionError ? '⚠ ' : 'Error: ') + e.message); } };
    const hdr = $('hdr');
    hdr.onpointerdown = e => startDrag(e, hdr);
    hdr.ondblclick = e => { if (!e.target.closest('button')) { S.settings.pos = null; saveSettings(); placeHost(); } };
    $('min').onclick = () => { visible = false; render(); };
    $('gear').onclick = () => { showSettings = !showSettings; render(); };
    if ($('s_save')) $('s_save').onclick = async () => {
      const bs = Math.round(+$('s_bs').value);
      if (!(bs >= 1 && bs <= 500)) { setMsg('Batch size must be 1–500.'); return; }
      s.batchSize = bs;
      s.outlet = $('s_outlet').value.trim(); s.user = $('s_user').value.trim(); s.ver = $('s_ver').value.trim();
      s.delayMs = Math.max(0, +$('s_delay').value || 0);
      readFileBoxes();
      await saveSettings(); setMsg(`Settings saved. Batch size is now ${bs}.`);
    };
    const FK = ['docJson', 'histCsv', 'histJson', 'attCsv', 'manifest'];
    const readFileBoxes = () => { for (const k of FK) if ($('f_' + k)) s.files[k] = $('f_' + k).checked; };
    for (const k of FK) if ($('f_' + k)) $('f_' + k).onchange = async () => { readFileBoxes(); await saveSettings(); render(); };
    const preset = async p => { Object.assign(s.files, p); await saveSettings(); setMsg('File selection saved.'); };
    if ($('f_all')) $('f_all').onclick = () => preset({ docJson: true, histCsv: true, histJson: true, attCsv: true, manifest: true });
    if ($('f_csv')) $('f_csv').onclick = () => preset({ docJson: false, histCsv: true, histJson: false, attCsv: true, manifest: true });
    if ($('f_json')) $('f_json').onclick = () => preset({ docJson: true, histCsv: false, histJson: true, attCsv: false, manifest: false });
    if ($('f_none')) $('f_none').onclick = () => preset({ docJson: false, histCsv: false, histJson: false, attCsv: false, manifest: false });
    if ($('s_detect')) $('s_detect').onclick = async () => { detectSession(); await detectUserFallback(); await saveSettings(); render(); };
    if ($('s_pos')) $('s_pos').onclick = async () => { s.pos = null; await saveSettings(); placeHost(); };
    $('li').oninput = e => { liText = e.target.value; };
    $('li').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('lidl').click(); };
    $('lidl').onclick = safeRun(() => downloadSpecific(liText));
    if ($('pause')) $('pause').onclick = () => { S.run.paused = !S.run.paused; render(); };
    if ($('cancel')) $('cancel').onclick = () => { S.run.cancel = true; S.run.paused = false; };
    if ($('approve')) $('approve').onclick = safeRun(approve);
    if ($('discard')) $('discard').onclick = discard;
    if ($('prep')) $('prep').onclick = safeRun(prepareBatch);
    $('autoc').onchange = async e => { s.autoContinue = e.target.checked; await saveSettings(); };
    $('autoa').onchange = async e => {
      if (e.target.checked && !confirm('Auto-approve downloads every batch without asking. Continue?')) { e.target.checked = false; return; }
      s.autoApprove = e.target.checked; await saveSettings();
    };
    $('build').onclick = safeRun(buildIndex);
    $('refresh').onclick = safeRun(refreshIndex);
    $('imp').onclick = () => $('file').click();
    $('file').onchange = safeRun(async () => { const f = $('file').files[0]; if (f) await importLog(await f.text()); });
    $('exp').onclick = () => saveBlob(new Blob([progressCsv()], { type: 'text/csv' }), `TIPS_progress_log_${new Date().toISOString().slice(0, 10)}.csv`);
    placeHost();
  }
  function renderProgress() {
    const bar = root.getElementById('pbar'), lab = root.getElementById('plabel');
    if (bar && S.run) bar.style.width = (100 * (S.run.i - 1) / S.run.total).toFixed(1) + '%';
    if (lab && S.run) lab.textContent = S.run.label;
  }

  window.addEventListener('beforeunload', e => { if (S.run || S.pending) { e.preventDefault(); e.returnValue = ''; } });
  if (hasChrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((m, _s, reply) => { if (m && m.type === 'toggle') { visible = !visible; render(); } reply && reply(true); });
  }

  if (!hasChrome) window.__TIPSX_DEBUG = { S, importLog, prepareBatch, approve, discard, render, progressCsv, nextBatch, downloadSpecific };

  document.documentElement.appendChild(host);
  load().then(async () => { if (!S.settings.user) await detectUserFallback(); await saveSettings(); render(); });
  // Late detection: the Reader fires its first API calls after load
  setTimeout(() => { if (!sessionOK()) { detectSession(); saveSettings(); render(); } }, 5000);
})();
