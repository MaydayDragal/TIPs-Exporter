/* TIPS Exporter – page probe (runs in the page's own JS world, before the Reader loads).
 * Read-only: requests are passed through unchanged. It notes two things the exporter can't see from its own world:
 *  - the pagination.pageSize of the Reader's own topic searches, so the index search can match it;
 *  - the address the Reader loads an open case from (normal or external cases), so the case toolbar button
 *    can load exactly that case.
 */
(() => {
  if (window.__TIPSX_PROBE__) return;
  window.__TIPSX_PROBE__ = true;

  function note(url, body) {
    try {
      if (!/\/topics\/search/.test(String(url)) || typeof body !== 'string') return;
      const j = JSON.parse(body);
      const n = j && j.pagination && j.pagination.pageSize;
      if (!Number.isInteger(n) || n < 1 || j.totalHitsCountOnly) return;
      document.documentElement.dataset.tipsxPageSize = String(n);   // DOM is shared with the content script
      window.postMessage({ __tipsx: 'pageSize', size: n }, location.origin);
    } catch (e) { }
  }

  // Last few case-related requests (method + path), shown masked in the exporter's Check setup.
  function logCase(u, method) {
    try {
      const log = JSON.parse(document.documentElement.dataset.tipsxCaseLog || '[]');
      log.push(`${(method || 'GET').toUpperCase()} ${u.pathname}${u.search}`);
      document.documentElement.dataset.tipsxCaseLog = JSON.stringify(log.slice(-8));
    } catch (e) { }
  }
  // A GET for a single case: a path containing "case" that ends in an id, not the case list or side calls.
  function noteCase(url, method) {
    try {
      const u = new URL(String(url), location.href);
      if (u.origin === location.origin && /case|anonym/i.test(u.pathname)) logCase(u, method);
      if ((method || 'GET').toUpperCase() !== 'GET') return;
      if (u.origin !== location.origin || !/case/i.test(u.pathname) || u.searchParams.has('folder')) return;
      if (/summari|sendtarget|attachment|watchlist|favo|rating|\/cases\/?$/i.test(u.pathname)) return;
      if (!/\/[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{3,}\/?$/.test(u.pathname)) return;
      document.documentElement.dataset.tipsxCaseUrl = u.pathname + u.search;
      document.documentElement.dataset.tipsxCaseAt = String(Date.now());
    } catch (e) { }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      note(url, init && init.body);
      noteCase(url, (init && init.method) || (input && typeof input === 'object' && input.method));
    } catch (e) { }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__tipsxUrl = url; this.__tipsxMethod = method; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) { try { note(this.__tipsxUrl, body); noteCase(this.__tipsxUrl, this.__tipsxMethod); } catch (e) { } return origSend.apply(this, arguments); };
})();
