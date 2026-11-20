/* One click to renew File System Access for the saved folders. Chrome grants that access per browsing
   session, tied to an open extension page; the background worker alone cannot ask for it. A permission
   request needs a click on an extension page, so the TIPS Library tab opens this small window. */
(() => {
  const $ = id => document.getElementById(id);
  const FOLDERS = [{ key: 'connection', label: 'index log folder' }, { key: 'documentsConnection', label: 'documents folder' }];
  let pending = [];
  const granted = async r => await r.handle.queryPermission({ mode: 'readwrite' }) === 'granted';
  async function refresh() {
    pending = [];
    for (const f of FOLDERS) { const r = await TIPSFolderDB.get(f.key); if (r?.handle && !await granted(r)) pending.push({ ...f, record: r }); }
    if (!pending.length) {
      $('what').textContent = 'All folders are accessible.'; $('grant').disabled = true; $('grant').textContent = 'Done';
      await finish(); return;
    }
    const next = pending[0];
    $('what').textContent = 'TIPS Exporter needs access to: ' + pending.map(p => `${p.label} "${p.record.handle.name}"`).join(' and ') + '.';
    $('grant').textContent = pending.length > 1 ? `Allow access to the ${next.label}` : 'Allow access';
    $('grant').disabled = false;
  }
  async function finish() {
    // Resume saving the index right away; the documents folder is used by the next sync.
    try { const r = await chrome.runtime.sendMessage({ type: 'index-folder', action: 'load' }); if (r && !r.ok) throw Error(r.status?.message || r.error); }
    catch (e) { $('result').textContent = e.message; $('result').className = 'error'; return; }
    $('result').textContent = 'Access allowed. You can close this window.'; $('result').className = 'success';
    setTimeout(() => window.close(), 1500);
  }
  $('grant').onclick = async () => {
    const next = pending[0]; if (!next) return;
    $('grant').disabled = true;
    try {
      // Called directly in the click so Chrome shows its prompt.
      if (await next.record.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw Error(`Access to the ${next.label} was not allowed.`);
      $('result').textContent = '';
    } catch (e) { $('result').textContent = e.message || String(e); $('result').className = 'error'; }
    await refresh();
  };
  refresh().catch(e => { $('result').textContent = e.message; $('result').className = 'error'; });
})();
