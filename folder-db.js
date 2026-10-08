/* Extension-origin IndexedDB; native directory handles never pass through JSON messaging. */
(() => {
  let pending;
  const open = () => pending || (pending = new Promise((resolve, reject) => {
    const q = indexedDB.open('tips-exporter-index-folder', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv');
    q.onsuccess = () => resolve(q.result); q.onerror = () => { pending = null; reject(q.error); };
  }));
  const tx = (mode, action) => open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('kv', mode), request = action(t.objectStore('kv'));
    t.oncomplete = () => resolve(request.result); t.onerror = t.onabort = () => reject(t.error || request.error);
  }));
  globalThis.TIPSFolderDB = { get: k => tx('readonly', s => s.get(k)), put: (k, v) => tx('readwrite', s => s.put(v, k)), del: k => tx('readwrite', s => s.delete(k)) };
})();
