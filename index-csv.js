/* Shared portable index/progress format. No settings or session credentials are stored here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TIPSIndexCsv = api;
})(globalThis, () => {
  'use strict';
  const HEADER = ['index', 'batch', 'tips', 'tipsId', 'version_indexed', 'title', 'modification_date', 'status', 'exported_on'];
  const OPTIONAL = ['document_exceptions', 'attachment_inventory', 'prior_attachments_checked'];
  // prior_attachments_checked: versions 1…N were read for attachments a later revision removed.
  const escape = v => { let s = String(v ?? '').replace(/\r\n?|\n/g, ' '); if (/^[=+\-@\t]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const validVersion = v => Number.isSafeInteger(v) && v >= 1 && v <= 10000;
  const validDate = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
  function normalizeExceptions(value = []) {
    if (!Array.isArray(value) || value.length > 10000) throw Error('Invalid document exceptions: expected a version list.');
    const seen = new Set();
    return value.map(x => {
      const key = `${x?.kind === 'retryable' ? 'retry' : 'pdf'}:${x?.version}`;
      if (!x || !validVersion(x.version) || !['unavailable', 'scrub_failed', 'retryable'].includes(x.kind) ||
          typeof x.reason !== 'string' || !x.reason.trim() || x.reason.length > 1000 || /[\x00-\x1f]/.test(x.reason) || !validDate(x.at) || seen.has(key)) throw Error('Invalid document exception: check its version, type, reason, date, and duplicates.');
      seen.add(key); return { version: x.version, kind: x.kind, reason: x.reason, at: x.at };
    }).sort((a,b) => a.version - b.version || a.kind.localeCompare(b.kind));
  }
  function normalizeAttachmentInventory(value) {
    if (!value || !validDate(value.at) || !Array.isArray(value.files) || value.files.length > 100000) throw Error('Invalid attachment inventory.');
    const seen = new Set();
    const files = value.files.map(x => {
      const parts = typeof x?.path === 'string' ? x.path.split('/') : [];
      if (parts.length < 2 || parts.length > 10 || x.path.length > 2000 || parts.some(p => !p || p === '.' || p === '..' || /[\\:*?"<>|\x00-\x1f]/.test(p)) ||
          !Number.isSafeInteger(x.size) || x.size < 0 || !Number.isSafeInteger(x.lastModified) || x.lastModified < 0 || seen.has(x.path.toLowerCase())) throw Error('Invalid attachment path, size, date, or duplicate.');
      seen.add(x.path.toLowerCase()); return { path: x.path, size: x.size, lastModified: x.lastModified };
    }).sort((a,b) => a.path.localeCompare(b.path));
    return { at: value.at, files };
  }
  function applyExceptionEvents(index, events = []) {
    const next = index.map(x => ({ ...x })), byKey = new Map(next.map(x => [String(x.tips).toUpperCase() + ':' + String(x.tipsId), x])), ids = [];
    let changed = false;
    for (const e of events) {
      const row = byKey.get(String(e.tips).toUpperCase() + ':' + String(e.tipsId)); if (!row) continue;
      if (!validVersion(e.version) || !['exclude', 'resolve', 'resolve-retryable'].includes(e.action) || typeof e.id !== 'string') throw Error('Invalid document exception event.');
      const before = normalizeExceptions(row.exceptions), after = e.action === 'resolve-retryable' ? before.filter(x => x.kind !== 'retryable') :
        before.filter(x => !(x.version === e.version && x.kind !== 'retryable'));
      if (e.action === 'exclude') {
        const record = normalizeExceptions([e.exception])[0]; if (record.version !== e.version) throw Error('Invalid document exception version.');
        if (record.kind === 'retryable') { after.splice(0, after.length, ...before.filter(x => x.kind !== 'retryable')); }
        after.push(record);
      }
      const normalized = normalizeExceptions(after);
      if (JSON.stringify(before) !== JSON.stringify(normalized)) changed = true;
      if (normalized.length) row.exceptions = normalized; else delete row.exceptions;
      ids.push(e.id);
    }
    return { index: next, ids, changed };
  }
  function applyAttachmentInventories(index, updates = []) {
    const next = index.map(x => ({ ...x })), byKey = new Map(next.map(x => [String(x.tips).toUpperCase() + ':' + String(x.tipsId), x])); let changed = false;
    for (const update of updates) {
      const row = byKey.get(String(update.tips).toUpperCase() + ':' + String(update.tipsId)); if (!row) continue;
      const observed = normalizeAttachmentInventory(update.inventory), expected = row.attachmentInventory ? normalizeAttachmentInventory(row.attachmentInventory) : null;
      const files = new Map((expected?.files || []).map(x => [x.path.toLowerCase(), x]));
      for (const f of observed.files) if (!files.has(f.path.toLowerCase())) files.set(f.path.toLowerCase(), f);
      const merged = normalizeAttachmentInventory({ at: observed.at, files: [...files.values()] });
      if (JSON.stringify(expected) !== JSON.stringify(merged)) { row.attachmentInventory = merged; changed = true; }
    }
    return { index: next, changed };
  }
  const validChecked = v => Number.isSafeInteger(v) && v >= 0 && v <= 10000;
  function applyPriorChecks(index, updates = []) {
    const next = index.map(x => ({ ...x })), byKey = new Map(next.map(x => [String(x.tips).toUpperCase() + ':' + String(x.tipsId), x])); let changed = false;
    for (const u of updates) {
      const row = byKey.get(String(u.tips).toUpperCase() + ':' + String(u.tipsId)); if (!row) continue;
      if (!validChecked(u.through)) throw Error('Invalid earlier-attachment check.');
      if (u.through > (row.priorAttachmentsChecked || 0)) { row.priorAttachmentsChecked = u.through; changed = true; }
    }
    return { index: next, changed };
  }
  function rows(text) {
    const out = []; let row = [], field = '', quoted = false, closed = false;
    text = String(text).replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; }
      else if (c === ',' || c === '\r' || c === '\n') {
        row.push(field); field = ''; closed = false;
        if (c !== ',') { if (c === '\r' && text[i + 1] === '\n') i++; out.push(row); row = []; }
      } else if (c === '"' && !field && !closed) quoted = true;
      else { if (closed || c === '"') throw Error('Invalid quote in progress CSV.'); field += c; }
    }
    if (quoted) throw Error('Unclosed quote in progress CSV.');
    if (field || row.length || closed) { row.push(field); out.push(row); }
    // Older spreadsheet-edited logs can contain quoted rows of separators only.
    // Ignore those empty rows, while still rejecting partial rows containing topic data.
    return out.filter(r => r.some(x => !/^[,\s]*$/.test(x)));
  }
  function parse(text) {
    const all = rows(text), head = all.shift();
    if (!head || head.length < HEADER.length || head.slice(0, HEADER.length).some((x, i) => x.trim() !== HEADER[i]) ||
        head.slice(HEADER.length).map(x => x.trim()).some((x,i,a) => !OPTIONAL.includes(x) || a.indexOf(x) !== i)) throw Error('This file is not a TIPS index/progress CSV.');
    const index = [], done = {}, seen = new Set();
    for (const [n, row] of all.entries()) {
      if (row.length !== head.length) throw Error(`Progress CSV row ${n + 2} has the wrong number of columns.`);
      const [i, b, tips, tipsId, version, title, mdate, status, date] = row.map(x => /^'[=+\-@\t]/.test(x) ? x.slice(1) : x);
      if (!/^\d+$/.test(i) || +i < 1 || !tips.trim() || !/^[A-Za-z0-9_-]+$/.test(tipsId) || ['__proto__', 'constructor', 'prototype'].includes(tipsId)) throw Error(`Invalid topic in progress CSV row ${n + 2}.`);
      if (!/^\d+$/.test(version) || !Number.isSafeInteger(+version) || +version < 1) throw Error(`Invalid version in progress CSV row ${n + 2}.`);
      if (!['pending', 'exported'].includes(status)) throw Error(`Invalid status in progress CSV row ${n + 2}.`);
      if (status === 'exported' && (!/^\d+$/.test(b) || !Number.isSafeInteger(+b) || +b < 1)) throw Error(`Invalid batch in progress CSV row ${n + 2}.`);
      // Preserve opaque IDs (including numbers too large to represent exactly in JavaScript).
      const id = /^\d+$/.test(tipsId) && Number.isSafeInteger(+tipsId) ? +tipsId : tipsId;
      if (seen.has(String(id))) throw Error(`Duplicate topic ID in progress CSV row ${n + 2}.`);
      const item = { tips, tipsId: id, version: +version, title, mdate };
      for (const field of OPTIONAL) {
        const column = head.findIndex(x => x.trim() === field), text = column >= 0 ? row[column] : '';
        if (!text) continue;
        let value; try { value = JSON.parse(text); } catch (_) { throw Error(`Invalid ${field} JSON in progress CSV row ${n + 2}.`); }
        if (field === 'document_exceptions') { const list = normalizeExceptions(value); if (list.length) item.exceptions = list; }
        else if (field === 'prior_attachments_checked') { if (!validChecked(value)) throw Error(`Invalid ${field} in progress CSV row ${n + 2}.`); if (value) item.priorAttachmentsChecked = value; }
        else item.attachmentInventory = normalizeAttachmentInventory(value);
      }
      seen.add(String(id)); index.push(item);
      if (status === 'exported') done[id] = { b: +b, d: date, v: +version };
    }
    return { index, done };
  }
  function stringify(index, done = {}) {
    const fields = OPTIONAL.filter(field => index.some(x => field === 'document_exceptions' ? x.exceptions?.length : field === 'prior_attachments_checked' ? x.priorAttachmentsChecked : x.attachmentInventory));
    const out = [[...HEADER, ...fields].join(',')];
    index.forEach((x, i) => {
      const d = done[x.tipsId], s = d && (d.v == null || +d.v === +x.version) ? d : null;
      const extra = fields.map(field => field === 'document_exceptions' ? x.exceptions?.length ? JSON.stringify(normalizeExceptions(x.exceptions)) : ''
        : field === 'prior_attachments_checked' ? validChecked(x.priorAttachmentsChecked) && x.priorAttachmentsChecked ? String(x.priorAttachmentsChecked) : ''
        : x.attachmentInventory ? JSON.stringify(normalizeAttachmentInventory(x.attachmentInventory)) : '');
      out.push([i + 1, s ? s.b : '', x.tips, x.tipsId, x.version, x.title, x.mdate, s ? 'exported' : 'pending', s ? s.d : '', ...extra].map(escape).join(','));
    });
    return out.join('\r\n');
  }
  return { parse, stringify, escape, normalizeExceptions, applyExceptionEvents, normalizeAttachmentInventory, applyAttachmentInventories, applyPriorChecks };
});
