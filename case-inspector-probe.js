/* Passive case observer. Never sends extra backend traffic or modifies a response. */
(() => {
  'use strict';
  if (window.__TIPSX_CASE_PROBE__ || !globalThis.TipsCaseCore) return;
  window.__TIPSX_CASE_PROBE__ = true;
  const C = globalThis.TipsCaseCore, store = C.createStore();
  let paused = false, epoch = 0, nextId = 0;
  const activeReads = new Set();
  function invalidate() { epoch++; for (const cancel of [...activeReads]) cancel('Capture cleared or paused'); }
  const emit = data => { try { window.postMessage({ type: 'tipsx-case-data', ...data }, location.origin); } catch {} };
  const snapshot = () => emit({ kind: 'snapshot', records: store.list(), paused, dropped: store.dropped });
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin || e.data?.type !== 'tipsx-case-command') return;
    switch (e.data.action) {
      case 'snapshot': snapshot(); break;
      case 'clear': invalidate(); store.clear(); snapshot(); break;
      case 'pause': invalidate(); paused = true; snapshot(); break;
      case 'resume': paused = false; snapshot(); break;
    }
  });
  function begin(url, method) {
    if (paused || !C.eligible(url, location.pathname)) return null;
    return { id: ++nextId, route: location.pathname, url: C.cleanUrl(url), method: method || 'GET', started: new Date().toISOString(), clock: performance.now(), epoch };
  }
  function finish(rec, request, response, status) {
    if (!rec || paused || rec.epoch !== epoch) return;
    const accepted = store.add({ ...rec, request, response, status, duration: Math.round(performance.now() - rec.clock) });
    if (accepted) emit({ kind: 'record', record: accepted, paused, dropped: store.dropped });
  }
  const omitted = reason => ({ state: 'omitted', reason });
  // Read a clone with a hard byte limit. Do not await cancel on a tee: the other branch belongs to XENTRY.
  async function readJSON(source, requireJSON) {
    if (activeReads.size >= 16) return omitted('Observer busy: 16 body reads already active');
    let reader, timer, stop;
    const cancelled = new Promise(resolve => { stop = reason => {
      try { reader?.cancel().catch(() => {}); } catch {}
      resolve({ stopped: reason });
    }; });
    activeReads.add(stop);
    try {
      const type = source.headers.get('content-type') || '';
      if (requireJSON && !/(?:application|text)\/(?:[\w.+-]*\+)?json\b/i.test(type)) return omitted('Non-JSON response');
      if (Number(source.headers.get('content-length')) > C.BODY_LIMIT) return omitted('Body exceeds 256 KiB');
      const copy = source.clone();
      if (!copy.body) return { state: 'empty' };
      reader = copy.body.getReader(); const decoder = new TextDecoder(); let size = 0, text = '';
      timer = setTimeout(() => stop('Observer body read timed out after 10 seconds'), 10000);
      while (true) {
        const result = await Promise.race([reader.read(), cancelled]);
        if (result.stopped) return omitted(result.stopped);
        const { done, value } = result; if (done) break;
        size += value.byteLength;
        if (size > C.BODY_LIMIT) { reader.cancel().catch(() => {}); return omitted('Body exceeds 256 KiB'); }
        text += decoder.decode(value, { stream: true });
      }
      return C.body(text + decoder.decode());
    } catch { return omitted('Body unavailable'); }
    finally { clearTimeout(timer); activeReads.delete(stop); try { reader?.releaseLock(); } catch {} }
  }

  function requestBody(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      const b = init.body;
      return Promise.resolve(b == null || typeof b === 'string' ? C.body(b) : omitted('Non-JSON request body'));
    }
    if (typeof Request !== 'undefined' && input instanceof Request) return readJSON(input, false);
    return Promise.resolve({ state: 'empty' });
  }
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') window.fetch = function (input, init) {
    let rec, request;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      rec = begin(url, init?.method || input?.method || 'GET');
      if (rec) request = requestBody(input, init);
    } catch {}
    // Call native exactly once with the caller's original this/arguments.
    const promise = originalFetch.apply(this, arguments);
    if (rec) promise.then(response => {
      if (paused || rec.epoch !== epoch) return;
      Promise.all([request, readJSON(response, true)]).then(([req, res]) => finish(rec, req, res, response.status)).catch(() => {});
    }, () => {
      request.then(req => finish(rec, req, { state: 'error', reason: 'Network error or aborted request' }, 0)).catch(() => {});
    }).catch(() => {});
    return promise;
  };
  const proto = XMLHttpRequest.prototype, open = proto.open, send = proto.send, meta = new WeakMap();
  proto.open = function (method, url) {
    // Retire a prior listener before native open aborts a reused XHR.
    const old = meta.get(this); if (old?.listener) this.removeEventListener('loadend', old.listener);
    const result = open.apply(this, arguments); meta.set(this, { method, url }); return result;
  };
  proto.send = function (data) {
    const m = meta.get(this); let listener;
    try {
      const rec = m && begin(m.url, m.method);
      if (rec) {
        const request = data == null || typeof data === 'string' ? C.body(data) : omitted('Non-JSON request body');
        listener = () => {
          this.removeEventListener('loadend', listener);
          if (m.listener === listener) m.listener = null;
          try {
            let response;
            if (!this.status) response = { state: 'error', reason: 'Network error or aborted request' };
            else if (this.responseType === 'json') response = C.body(this.response);
            else if ((!this.responseType || this.responseType === 'text') && /json/i.test(this.getResponseHeader('content-type') || '')) response = C.body(this.responseText);
            else response = omitted('Non-JSON response');
            finish(rec, request, response, this.status);
          } catch { finish(rec, request, omitted('Body unavailable'), this.status || 0); }
        };
        m.listener = listener; this.addEventListener('loadend', listener);
      }
    } catch {}
    try { return send.apply(this, arguments); }
    catch (error) { if (listener) this.removeEventListener('loadend', listener); throw error; }
  };
})();
