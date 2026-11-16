/* Isolated-world viewer. Page data is untrusted; never insert it as HTML. */
(() => {
  'use strict';
  if (globalThis.TipsCaseInspector || !globalThis.TipsCaseCore) return;
  const C = globalThis.TipsCaseCore, store = C.createStore();
  let paused = false, dropped = 0, connected = false, tab = 'overview', query = '', context = '@current', notice = '', changed = () => {};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = v => JSON.stringify(v, null, 2);
  const short = (s, n = 8000) => String(s).length > n ? String(s).slice(0, n) + '\n…[preview shortened; inspect Raw data]' : String(s);
  const command = action => window.postMessage({ type: 'tipsx-case-command', action }, location.origin);
  const current = () => context === '@current' ? location.pathname : context;
  const selected = () => store.list().filter(r => r.route === current());
  const filtered = () => selected().filter(r => !query || json(r).toLowerCase().includes(query.toLowerCase()));
  function payload() {
    return json({ format: 'tips-case-inspector-v1', exportedAt: new Date().toISOString(), context: current(),
      note: 'Context is the page where a request started, not verified case ownership. Named credentials are redacted; free text can contain personal information.',
      dropped: Math.max(dropped, store.dropped), records: filtered() });
  }
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin || e.data?.type !== 'tipsx-case-data') return;
    const d = e.data;
    if (d.kind === 'snapshot' && Array.isArray(d.records) && d.records.length <= 100) {
      store.clear(); for (const record of d.records) store.add(record);
    } else if (d.kind === 'record') { if (!store.add(d.record)) return; }
    else return;
    connected = true; paused = d.paused === true; dropped = Number.isSafeInteger(d.dropped) ? Math.max(0, d.dropped) : 0; changed();
  });
  const row = r => `<div class="case-field"><b>${esc(r.path)}</b><pre>${esc(short(typeof r.value === 'string' ? r.value : json(r.value)))}</pre><small>Response #${r.id} · ${esc(r.started)}<br>${esc(r.url)}</small></div>`;
  function html() {
    const records = filtered(), summary = C.summarize(records), routes = [...new Set(store.list().map(r => r.route))];
    const selectedContext = current();
    const header = `<style>
      .case-inspector{display:flex;flex-direction:column;gap:14px;min-width:0}.case-inspector select,.case-inspector input{box-sizing:border-box;width:100%;padding:9px;border:1px solid #aaa;background:#fff;color:#222;font:inherit}
      .case-inspector .case-controls{display:flex;gap:8px;flex-wrap:wrap}.case-inspector pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 monospace;margin:8px 0;max-height:360px;overflow:auto}
      .case-field,.case-record{padding:12px;border:1px solid #d4d4d4;background:#fafafa;overflow-wrap:anywhere}.case-field b{font:600 12px monospace}.case-field small{color:#555}
      .case-inspector summary{cursor:pointer;overflow-wrap:anywhere}.case-inspector .tabs{flex-wrap:wrap}.case-inspector h3{margin:0;font-size:16px}.case-inspector label{display:grid;gap:5px}.case-inspector .case-muted{color:#555;font-size:12px;line-height:1.5}
    </style><section class="case-inspector" aria-label="Case Inspector">
      <div><h3>Case Inspector</h3><p class="case-muted">Read-only view of data returned to this tab. Candidate fields may already be visible in XENTRY; server-only information cannot be revealed.</p></div>
      <div class="case-controls"><button class="b bar sm" id="case_pause">${paused ? 'Resume capture' : 'Pause capture'}</button><button class="b bar sm" id="case_clear">Clear all captures</button><button class="b bar sm" id="case_copy" ${records.length ? '' : 'disabled'}>Copy JSON</button><button class="b bar sm" id="case_export" ${records.length ? '' : 'disabled'}>Export JSON</button></div>
      <div class="case-muted" role="status">${connected ? paused ? 'Capture paused' : 'Capturing fetch/XHR' : 'Waiting for page observer — reload XENTRY if needed'} · ${records.length} matching / ${selected().length} in context · ${store.list().length} in tab${Math.max(dropped, store.dropped) ? ` · ${Math.max(dropped, store.dropped)} older captures discarded` : ''}. Memory only; reload clears captures.</div>
      <label>Case / page context<select id="case_context"><option value="@current" ${context === '@current' ? 'selected' : ''}>Current page — ${esc(location.pathname)}</option>${routes.map(route => `<option value="${esc(route)}" ${context === route ? 'selected' : ''}>${esc(route)}</option>`).join('')}</select></label>
      <div class="case-muted">Requests are grouped by their start page, not verified case ownership. Open a case and its communication/history tabs to capture their responses.</div>
      <label>Search captured data<input id="case_search" type="search" value="${esc(query)}" placeholder="rating, message, status, field name…"></label>
      <div class="tabs" role="tablist" aria-label="Case Inspector views">${[['overview','Overview'],['communication','Communication'],['raw','Raw data']].map(([id,label]) => `<button class="tab" role="tab" id="case_${id}" aria-selected="${tab === id}">${label}</button>`).join('')}</div>
      ${notice ? `<div role="status">${esc(notice)}</div>` : ''}`;
    let body = '';
    if (!records.length) body += `<p>No captured data ${query ? 'matches this search' : 'for this context'}. ${C.isCaseRoute(selectedContext) ? 'Open a case section or reload the case page to capture its normal requests.' : 'Navigate to a case in XENTRY, or select a previously captured context.'}</p>`;
    if (tab === 'overview') {
      body += '<h3>Rating candidates</h3><div class="case-muted">Raw values and field names. Scale and meaning are not assumed; null or absent values are unavailable.</div>';
      body += summary.ratings.length ? summary.ratings.slice(0, 30).map(row).join('') : '<p>Unavailable — no non-null rating field captured.</p>';
      body += '<h3>Returned metadata</h3><div class="case-muted">Newest responses first. Up to 150 scalar fields shown; Raw data contains the captured JSON.</div>';
      body += summary.fields.slice(0, 150).map(row).join('');
    } else if (tab === 'communication') {
      body += '<div class="case-muted">Candidates matched by field names such as messages, comments and replies. Internal/hidden status is not inferred. Unknown schemas remain searchable in Raw data.</div>';
      body += summary.communication.length ? summary.communication.slice(0, 60).map(row).join('') : '<p>No communication candidate fields found in captured responses.</p>';
    } else {
      body += '<div class="case-muted">JSON bodies only, up to 256 KiB each. Headers/cookies are not collected. Named credentials and signed URL parameters are redacted; case text may still contain personal information. Copy/export includes all matching records in this context.</div>';
      body += records.slice().reverse().map(r => `<details class="case-record" id="case_record_${r.id}" data-case-id="${r.id}"><summary>#${r.id} · ${esc(r.method)} · HTTP ${r.status} · ${r.duration} ms<br>${esc(r.url)}<br><small>${esc(r.started)} · Response: ${esc(r.response.state)}${r.response.reason ? ' — ' + esc(r.response.reason) : ''}</small></summary><pre></pre></details>`).join('');
    }
    if (summary.limited) body += '<p class="case-muted">Summary limit reached. Use search or Raw data for the remaining captured fields.</p>';
    return header + body + '</section>';
  }
  function bind(root, refresh) {
    const $ = id => root.getElementById(id), on = (id, event, fn) => { const el = $(id); if (el) el[event] = fn; };
    for (const name of ['overview', 'communication', 'raw']) on('case_' + name, 'onclick', () => { tab = name; notice = ''; refresh(); });
    on('case_search', 'oninput', e => { query = e.target.value; refresh(); });
    on('case_context', 'onchange', e => { context = e.target.value; notice = ''; refresh(); });
    on('case_pause', 'onclick', () => { paused = !paused; command(paused ? 'pause' : 'resume'); refresh(); });
    on('case_clear', 'onclick', () => { store.clear(); dropped = 0; notice = ''; command('clear'); refresh(); });
    on('case_copy', 'onclick', async () => {
      try { await navigator.clipboard.writeText(payload()); notice = 'Copied matching captures as JSON.'; }
      catch { notice = 'Clipboard unavailable. Use Export JSON instead.'; }
      refresh();
    });
    on('case_export', 'onclick', () => {
      const url = URL.createObjectURL(new Blob([payload()], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'TIPS-case-inspector-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice = 'Exported matching captures. Case text may contain personal information.'; refresh();
    });
    for (const el of root.querySelectorAll('[data-case-id]')) {
      const fill = () => { if (el.open) { const r = store.list().find(r => r.id === Number(el.dataset.caseId)); el.querySelector('pre').textContent = r ? json(r) : 'Capture no longer retained.'; } };
      el.ontoggle = fill; fill();
    }
  }
  globalThis.TipsCaseInspector = Object.freeze({ html, bind, onChange(callback) { changed = callback; } });
  // The retry covers nondeterministic ordering between the MAIN and ISOLATED document_start scripts.
  command('snapshot'); setTimeout(() => command('snapshot'), 500);
  let lastRoute = location.pathname;
  setInterval(() => { if (location.pathname !== lastRoute) { lastRoute = location.pathname; notice = ''; changed(); } }, 750);
})();
