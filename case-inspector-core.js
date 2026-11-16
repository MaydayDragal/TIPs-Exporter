/* Shared, dependency-free helpers. Loaded separately in MAIN and ISOLATED worlds. */
(() => {
  'use strict';
  if (globalThis.TipsCaseCore) return;
  const BODY_LIMIT = 256 * 1024, RECORD_LIMIT = 100, STORE_LIMIT = 2 * 1024 * 1024;
  const ORIGIN = 'https://xentry.mercedes-benz.com';
  const secret = /authorization|cookie|password|passwd|secret|token|session|credential|api[-_]?key|readkey|signature|x-amz-|x-goog-/i;
  const bytes = s => new TextEncoder().encode(s).length;
  function cleanUrl(value) {
    try {
      const u = new URL(String(value), ORIGIN); u.username = ''; u.password = ''; u.hash = '';
      for (const key of [...u.searchParams.keys()]) if (secret.test(key)) u.searchParams.set(key, '[redacted]');
      return u.href;
    } catch { return '[invalid URL]'; }
  }
  function sanitize(value) {
    let budget = BODY_LIMIT, nodes = 0; const seen = new WeakSet();
    function visit(v, depth) {
      if (++nodes > 5000 || depth > 20 || budget <= 0) return '[truncated]';
      if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
      if (typeof v === 'string') {
        let s = v.replace(/https?:\/\/[^\s<>"']+/g, match => cleanUrl(match));
        // Signed links also arrive as relative paths or query-only URLs.
        if (/^(?:\/|\.\.?\/|\?)[^\s<>]*$/.test(s) && s.includes('?')) s = cleanUrl(s);
        else s = s.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (all, sep, key) => {
          try { return secret.test(decodeURIComponent(key)) ? sep + key + '=[redacted]' : all; } catch { return all; }
        });
        s = s.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]');
        const max = Math.min(16000, Math.max(0, Math.floor(budget / 4)));
        if (s.length > max) s = s.slice(0, max) + '…[truncated]';
        budget -= s.length * 4; return s;
      }
      if (typeof v !== 'object') return '[unsupported]';
      if (seen.has(v)) return '[circular]'; seen.add(v);
      const out = Array.isArray(v) ? [] : Object.create(null);
      for (const k of Object.keys(v)) {
        if (budget <= 0 || nodes >= 5000) { if (Array.isArray(out)) out.push('[truncated]'); else out['[truncated]'] = true; break; }
        const key = k.slice(0, 200); budget -= key.length * 4;
        out[key] = secret.test(k) ? '[redacted]' : visit(v[k], depth + 1);
      }
      return out;
    }
    return visit(value, 0);
  }
  // Count actual JSON bytes without building one potentially huge serialized object.
  function fitsJSON(value) {
    let size = 0, nodes = 0; const seen = new WeakSet();
    function count(v, depth) {
      if (++nodes > 20000 || depth > 64 || size > BODY_LIMIT) return false;
      if (v && typeof v === 'object') {
        if (seen.has(v)) return false; seen.add(v);
        const keys = Object.keys(v); size += 2 + Math.max(0, keys.length - 1);
        for (const k of keys) {
          if (!Array.isArray(v)) { if (k.length > BODY_LIMIT) return false; size += bytes(JSON.stringify(k)) + 1; }
          if (!count(v[k], depth + 1)) return false;
        }
      } else {
        if (typeof v === 'string' && v.length > BODY_LIMIT) return false;
        size += bytes(JSON.stringify(v) ?? 'null');
      }
      return size <= BODY_LIMIT;
    }
    return count(value, 0);
  }
  function jsonBody(value) {
    if (!fitsJSON(value)) return { state: 'omitted', reason: 'Body exceeds 256 KiB or structural limits' };
    const clean = sanitize(value);
    return fitsJSON(clean) ? { state: 'json', value: clean } : { state: 'omitted', reason: 'Sanitized body exceeds 256 KiB' };
  }
  function body(value) {
    if (value == null || value === '') return { state: 'empty' };
    if (typeof value === 'string') {
      if (value.length > BODY_LIMIT || bytes(value) > BODY_LIMIT) return { state: 'omitted', reason: 'Body exceeds 256 KiB' };
      try { value = JSON.parse(value); } catch { return { state: 'omitted', reason: 'Non-JSON body' }; }
    } else if (typeof value !== 'object') return { state: 'omitted', reason: 'Unsupported body' };
    return jsonBody(value);
  }
  function isCaseRoute(route) { return /^\/tips-reader\/(?:[^?#]*\/)?cases(?:\/|$)/i.test(route); }
  function eligible(url, route) {
    try {
      const u = new URL(url, ORIGIN);
      if (u.origin !== ORIGIN || !/^\/tips\/[^/]+\/api\//.test(u.pathname)) return false;
      if (/\/(?:currentuser|login|logout|oauth|token|session|authentication)(?:\/|$)/i.test(u.pathname)) return false;
      return isCaseRoute(route) || /\/cases?(?:\/|$)|\/case-service\//i.test(u.pathname);
    } catch { return false; }
  }
  function normalize(record) {
    if (!record || !Number.isSafeInteger(record.id) || record.id < 1 || typeof record.route !== 'string' || typeof record.url !== 'string') return null;
    if (!eligible(record.url, record.route)) return null;
    const cleanBody = b => {
      if (!b || !['json', 'empty', 'omitted', 'error'].includes(b.state)) return { state: 'omitted', reason: 'Invalid capture' };
      if (b.state === 'json') return jsonBody(b.value);
      return { state: b.state, ...(b.reason ? { reason: String(b.reason).slice(0, 200) } : {}) };
    };
    return { id: record.id, route: record.route.split(/[?#]/)[0].slice(0, 500), url: cleanUrl(record.url).slice(0, 4000),
      method: String(record.method || 'GET').slice(0, 20), status: Number.isFinite(record.status) ? record.status : 0,
      started: String(record.started || '').slice(0, 40), duration: Math.max(0, Number(record.duration) || 0),
      request: cleanBody(record.request), response: cleanBody(record.response) };
  }
  function createStore() {
    const records = []; let total = 0, dropped = 0;
    return {
      add(raw) {
        const record = normalize(raw); if (!record) return null;
        if (records.some(x => x.record.id === record.id)) return null;
        const size = bytes(JSON.stringify(record));
        if (size > STORE_LIMIT) { dropped++; return null; }
        records.push({ record, size }); total += size;
        while (records.length > RECORD_LIMIT || total > STORE_LIMIT) { total -= records.shift().size; dropped++; }
        return record;
      },
      list: () => records.map(x => x.record),
      clear() { records.length = 0; total = 0; dropped = 0; },
      get dropped() { return dropped; }
    };
  }
  function summarize(records) {
    const fields = [], ratings = [], communication = []; let visited = 0;
    for (const record of records.slice().reverse()) {
      function walk(value, path, depth) {
        if (++visited > 5000 || depth > 20) return;
        if (value && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) {
            const p = path + (Array.isArray(value) ? '[' + key + ']' : '.' + key);
            const row = { id: record.id, url: record.url, path: p, value: child, started: record.started };
            if (/rating|\bstars?\b|bewertung|score/i.test(key) && child !== null) ratings.push(row);
            if (/message|communication|comment|correspondence|conversation|reply|remark|nachricht/i.test(key)) communication.push(row);
            walk(child, p, depth + 1);
          }
        } else if (fields.length < 1000) fields.push({ id: record.id, url: record.url, path, value, started: record.started });
      }
      if (record.response.state === 'json') walk(record.response.value, '$', 0);
    }
    return { fields, ratings, communication, limited: visited > 5000 || fields.length >= 1000 };
  }
  globalThis.TipsCaseCore = Object.freeze({ BODY_LIMIT, cleanUrl, sanitize, body, isCaseRoute, eligible, normalize, createStore, summarize });
})();
