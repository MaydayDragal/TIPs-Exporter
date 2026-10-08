(() => {
  const $ = id => document.getElementById(id);
  let selected = null, current = null, working = false;
  const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'documents-folder', action, ...extra });
  const note = (message, error = false) => { $('documents-result').textContent = message; $('documents-result').className = error ? 'error' : 'success'; };
  function controls() {
    $('choose-documents').disabled = working || typeof window.showDirectoryPicker !== 'function';
    $('use-documents').disabled = working || !selected;
    for (const id of ['save-documents', 'allow-documents', 'disconnect-documents']) $(id).disabled = working || !current;
    $('documents-attachments').disabled = $('documents-auto').disabled = working;
  }
  async function refresh() {
    current = await TIPSFolderDB.get('documentsConnection') || null;
    const r = await send('status'), s = r?.status;
    $('documents-location').textContent = current ? current.handle.name : 'No documents folder selected';
    $('documents-status').textContent = s?.message || 'Choose the parent containing your saved LI folders.';
    if (current && !selected) { $('documents-attachments').value = current.attachmentFolder; $('documents-auto').checked = current.auto; }
    controls();
  }
  async function act(fn) {
    if (working) return; working = true; controls();
    try { const r = await fn(); if (r && !r.ok) throw Error(r.error || 'Documents folder settings could not be saved.');
      if (r) note(r.status?.message || 'Documents folder access is ready. Open Bulk export in TIPS to scan and verify.'); await refresh();
    } catch (e) { if (e.name !== 'AbortError') note(e.message || String(e), true); }
    finally { working = false; controls(); }
  }
  const config = () => ({ attachmentFolder: $('documents-attachments').value, auto: $('documents-auto').checked });
  $('choose-documents').onclick = () => act(async () => {
    selected = await window.showDirectoryPicker({ id: 'tips-documents-folder', mode: 'readwrite' });
    $('selected-documents').textContent = selected.name; note('Choose Use this documents folder to connect it.');
  });
  $('use-documents').onclick = () => act(async () => {
    const token = crypto.randomUUID(); await TIPSFolderDB.put('documents-candidate:' + token, { handle: selected });
    const r = await send('connect', { token, options: config() }); if (r?.ok) selected = null; return r;
  });
  $('save-documents').onclick = () => act(() => send('configure', { options: config() }));
  $('allow-documents').onclick = () => act(async () => {
    // Request immediately inside the user's click; background work cannot prompt for permission.
    if (await current.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw Error('Documents folder access was not granted.');
    return send('inventory');
  });
  $('disconnect-documents').onclick = () => act(() => send('disconnect'));
  if (chrome.storage.onChanged) chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.documentsFolder && !working) refresh().catch(e => note(e.message, true)); });
  refresh().catch(e => note(e.message, true));
})();
