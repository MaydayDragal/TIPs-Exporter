/* Shared portable index/progress format. No settings or session credentials are stored here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TIPSIndexCsv = api;
})(globalThis, () => {
  'use strict';
  const HEADER = ['index', 'batch', 'tips', 'tipsId', 'version_indexed', 'title', 'modification_date', 'status', 'exported_on'];
  const escape = v => { let s = String(v ?? '').replace(/\r\n?|\n/g, ' '); if (/^[=+\-@\t]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
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
    if (!head || head.length !== HEADER.length || head.some((x, i) => x.trim() !== HEADER[i])) throw Error('This file is not a TIPS index/progress CSV.');
    const index = [], done = {}, seen = new Set();
    for (const [n, row] of all.entries()) {
      if (row.length !== HEADER.length) throw Error(`Progress CSV row ${n + 2} has the wrong number of columns.`);
      const [i, b, tips, tipsId, version, title, mdate, status, date] = row.map(x => /^'[=+\-@\t]/.test(x) ? x.slice(1) : x);
      if (!/^\d+$/.test(i) || +i < 1 || !tips.trim() || !/^[A-Za-z0-9_-]+$/.test(tipsId) || ['__proto__', 'constructor', 'prototype'].includes(tipsId)) throw Error(`Invalid topic in progress CSV row ${n + 2}.`);
      if (!/^\d+$/.test(version) || !Number.isSafeInteger(+version) || +version < 1) throw Error(`Invalid version in progress CSV row ${n + 2}.`);
      if (!['pending', 'exported'].includes(status)) throw Error(`Invalid status in progress CSV row ${n + 2}.`);
      if (status === 'exported' && (!/^\d+$/.test(b) || !Number.isSafeInteger(+b) || +b < 1)) throw Error(`Invalid batch in progress CSV row ${n + 2}.`);
      // Preserve opaque IDs (including numbers too large to represent exactly in JavaScript).
      const id = /^\d+$/.test(tipsId) && Number.isSafeInteger(+tipsId) ? +tipsId : tipsId;
      if (seen.has(String(id))) throw Error(`Duplicate topic ID in progress CSV row ${n + 2}.`);
      seen.add(String(id)); index.push({ tips, tipsId: id, version: +version, title, mdate });
      if (status === 'exported') done[id] = { b: +b, d: date, v: +version };
    }
    return { index, done };
  }
  function stringify(index, done = {}) {
    const out = [HEADER.join(',')];
    index.forEach((x, i) => {
      const d = done[x.tipsId], s = d && (d.v == null || +d.v === +x.version) ? d : null;
      out.push([i + 1, s ? s.b : '', x.tips, x.tipsId, x.version, x.title, x.mdate, s ? 'exported' : 'pending', s ? s.d : ''].map(escape).join(','));
    });
    return out.join('\r\n');
  }
  return { parse, stringify, escape };
});
