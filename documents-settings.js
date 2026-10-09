(() => {
  const $ = id => document.getElementById(id);
  let selected = null, current = null, working = false;
  const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'documents-folder', action, ...extra });
  const note = (message, error = false) => { $('documents-result').textContent = message; $('documents-result').className = error ? 'error' : 'success'; };
  function controls() {
    $('choose-documents').disabled = working || typeof window.showDirectoryPicker !== 'function';
    $('use-documents').disabled = working || !selected;
    for (const id of ['save-documents', 'allow-documents', 'disconnect-documents']) $(id).disabled = working || !current;
    $('documents-attachments').disabled = $('documents-auto').disabled = $('documents-poll-minutes').disabled = working;
  }
  async function refresh() {
    current = await TIPSFolderDB.get('documentsConnection') || null;
    const r = await send('status'), s = r?.status;
    $('documents-location').textContent = current ? current.handle.name : 'No documents folder selected';
    $('documents-status').textContent = s?.message || 'Choose the parent containing your saved document folders (LI/GI).';
    if (current && !selected) { $('documents-attachments').value = current.attachmentFolder; $('documents-auto').checked = current.auto; $('documents-poll-minutes').value = current.pollMinutes ?? 10; }
    controls();
  }
  async function act(fn) {
    if (working) return; working = true; controls();
    try { const r = await fn(); if (r && !r.ok) throw Error(r.error || 'Documents folder settings could not be saved.');
      if (r) note(r.status?.message || 'Documents folder access is ready. Open Library in TIPS to scan and verify.'); await refresh();
    } catch (e) { if (e.name !== 'AbortError') note(e.message || String(e), true); }
    finally { working = false; controls(); }
  }
  const config = () => {
    const pollMinutes = +$('documents-poll-minutes').value;
    if (!Number.isInteger(pollMinutes) || pollMinutes < 1 || pollMinutes > 1440) throw Error('Sync interval must be a whole number from 1 to 1440 minutes.');
    return { attachmentFolder: $('documents-attachments').value, auto: $('documents-auto').checked, pollMinutes };
  };
  $('choose-documents').onclick = () => act(async () => {
    selected = await window.showDirectoryPicker({ id: 'tips-documents-folder', mode: 'readwrite' });
    $('selected-documents').textContent = selected.name; note('Choose Use this documents folder to connect it.');
  });
  $('use-documents').onclick = () => act(async () => {
    const options = config(), token = crypto.randomUUID(); await TIPSFolderDB.put('documents-candidate:' + token, { handle: selected });
    const r = await send('connect', { token, options }); if (r?.ok) selected = null; return r;
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
