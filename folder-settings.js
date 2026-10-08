(() => {
  const $ = id => document.getElementById(id);
  let selected = null, current = null, working = false;
  const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'index-folder', action, ...extra });
  const note = (message, error = false) => { $('result').textContent = message; $('result').className = error ? 'error' : 'success'; };
  function controls() {
    $('choose-folder').disabled = working || typeof window.showDirectoryPicker !== 'function';
    $('use-folder').disabled = working || !selected;
    $('index-filename').disabled = working;
    for (const id of ['sync-now', 'allow-access', 'reload-index', 'disconnect']) $(id).disabled = working || !current;
  }
  async function refresh() {
    current = await TIPSFolderDB.get('connection') || null;
    const r = await send('status'), s = r?.status;
    $('current-location').textContent = current ? current.handle.name + ' / ' + current.filename : 'No folder selected';
    $('folder-status').textContent = s?.message || (current ? 'Choose Check & sync to check the folder.' : 'Progress is currently saved in Chrome.');
    $('folder-status').className = s?.configured && s.phase !== 'saved' ? 'error' : '';
    controls();
  }
  async function act(fn) {
    if (working) return; working = true; controls();
    try { const r = await fn(); if (r && !r.ok) throw Error(r.error || r.status?.message || 'The index could not be updated.');
      if (r) note(r.status?.message || 'Index folder settings updated.'); await refresh();
    } catch (e) { if (e.name !== 'AbortError') note(e.message || String(e), true); }
    finally { working = false; controls(); }
  }
  $('choose-folder').onclick = () => act(async () => {
    // Called immediately within the click gesture; filesystem permission belongs to this extension page.
    const handle = await window.showDirectoryPicker({ id: 'tips-index-folder', mode: 'readwrite' });
    const names = []; for await (const entry of handle.values()) if (entry.kind === 'file' && /\.csv$/i.test(entry.name)) names.push(entry.name);
    names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    selected = handle; $('chosen-folder').textContent = handle.name;
    $('index-files').replaceChildren(...names.map(name => { const o = document.createElement('option'); o.value = name; return o; }));
    $('index-filename').value = names.includes(TIPSIndexFolder.DEFAULT_FILE) || !names.length ? TIPSIndexFolder.DEFAULT_FILE : names.length === 1 ? names[0] : '';
    if (!names.length) note('This folder has no CSV files. A new index will be created from your browser progress.');
    else note('Select the index CSV, then choose Use this folder and index.');
  });
  $('use-folder').onclick = () => act(async () => {
    const filename = TIPSIndexFolder.validName($('index-filename').value), token = crypto.randomUUID();
    await TIPSFolderDB.put('candidate:' + token, { handle: selected, filename });
    return send('connect', { token });
  });
  $('allow-access').onclick = () => act(async () => {
    if (await current.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw Error('Folder access was not granted. Your browser progress is retained.');
    return send('load');
  });
  $('sync-now').onclick = () => act(() => send('load'));
  $('reload-index').onclick = () => {
    if (confirm('Replace the browser index and export progress with the file in this folder? Any progress saved only in Chrome will be replaced.')) act(() => send('reload'));
  };
  $('disconnect').onclick = () => act(() => send('disconnect'));
  if (chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.indexFolder && !working) refresh().catch(e => note(e.message, true)); });
  $('version').textContent = chrome.runtime.getManifest ? 'v' + chrome.runtime.getManifest().version : '';
  if (typeof window.showDirectoryPicker !== 'function') note('Folder access is unavailable here. Open this page in the Chrome extension.', true);
  refresh().catch(e => note(e.message, true));
})();
