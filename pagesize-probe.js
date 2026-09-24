/* TIPS Exporter – page probe (runs in the page's own JS world, before the Reader loads).
 * Watches the Reader's own topic-search requests and records the pagination.pageSize it uses (so the exporter's
 * index search can match it) and the last search itself (for "Use search"). Read-only: requests pass through unchanged.
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
      if (!j.docName) document.documentElement.dataset.tipsxLastSearch = body;   // the user's own search (not a single-LI lookup)
      window.postMessage({ __tipsx: 'pageSize', size: n }, location.origin);
    } catch (e) { }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try { note(typeof input === 'string' ? input : input && input.url, init && init.body); } catch (e) { }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__tipsxUrl = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) { try { note(this.__tipsxUrl, body); } catch (e) { } return origSend.apply(this, arguments); };
})();
