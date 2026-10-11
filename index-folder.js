/* Serialized folder-index reconciliation, independent of browser UI and storage adapters. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./index-csv.js'));
  else root.TIPSIndexFolder = factory(root.TIPSIndexCsv);
})(globalThis, CSV => {
  'use strict';
  const DEFAULT_FILE = '_progress_log_all_documents.csv', MAX_BYTES = 32 * 1024 * 1024;
  function validName(name) {
    name = String(name || '').trim();
    if (!name || name.length > 160 || !/\.csv$/i.test(name) || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /^[. ]|[. ]$/.test(name)) throw Error('Choose a CSV filename inside the selected folder.');
    return name;
  }
  const stateText = s => CSV.stringify(s.index || [], s.done || {});
  function create(deps) {
    let tail = Promise.resolve();
    const queue = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
    const now = deps.now || (() => new Date().toISOString());
    const epoch = deps.newEpoch || (() => globalThis.crypto.randomUUID());
    const disconnected = () => ({ configured: false, epoch: null, phase: 'disconnected', message: 'No index folder selected. Progress is saved in Chrome.' });
    async function status(record, phase = 'saved', message = '') {
      const s = record ? { configured: true, folderName: record.handle.name, filename: record.filename, epoch: record.epoch,
        phase, lastSynced: record.lastSynced || null, message: message || 'Index is up to date in the selected folder.' } : disconnected();
      await deps.writeStatus(s); return s;
    }
    async function access(handle) {
      if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw Object.assign(Error('Allow folder access in Settings to resume saving the index. Browser progress is retained.'), { code: 'permission' });
    }
    async function read(handle, name) {
      try {
        const file = await (await handle.getFileHandle(name)).getFile();
        if (file.size > MAX_BYTES) throw Error('The index file is larger than 32 MB.');
        return await file.text();
      } catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
    }
    async function write(handle, name, text, createFile = false) {
      const file = await handle.getFileHandle(name, { create: createFile });
      const stream = await file.createWritable();
      try { await stream.write(text); await stream.close(); }
      catch (e) { try { await stream.abort(); } catch (_) {} throw e; }
    }
    async function failure(record, e) {
      const phase = e.code || (/NotAllowed|Security/.test(e.name || '') ? 'permission' : 'error');
      const message = phase === 'permission' ? 'Allow folder access in Settings to resume saving the index. Browser progress is retained.' : e.message + ' Browser progress is retained.';
      return { ok: false, status: await status(record, phase, message) };
    }
    async function sync(record, allowRead) {
      try {
        await access(record.handle);
        const local = await deps.readState(), localText = stateText(local);
        CSV.parse(localText);
        const diskText = await read(record.handle, record.filename);
        if (diskText == null) throw Error('The configured index file is missing. Reconnect the folder to create it again.');
        const disk = CSV.parse(diskText), canonicalDisk = stateText(disk), baseline = stateText(CSV.parse(record.expectedText));
        // Compare content, not bytes: a file only re-saved with other line endings or quoting has not changed.
        if (canonicalDisk !== baseline && canonicalDisk !== localText) {
          if (localText !== baseline || !allowRead) throw Object.assign(Error('The folder index changed outside this installation. Reconnect and choose which index to use in Settings.'), { code: 'conflict' });
          await deps.writeState(disk, { reset: true });
        } else if (localText !== canonicalDisk) {
          await write(record.handle, record.filename, localText);
          record = { ...record, expectedText: localText };
        }
        if (diskText !== record.expectedText && canonicalDisk === localText || allowRead && localText === baseline) {
          // Preserve the exact bytes last read, including a legacy CSV's harmless formatting.
          record = { ...record, expectedText: diskText };
        }
        record = { ...record, lastSynced: now() };
        await deps.writeRecord(record);
        return { ok: true, status: await status(record) };
      } catch (e) { return failure(record, e); }
    }
    return {
      connect: (handle, filename = DEFAULT_FILE) => queue(async () => {
        filename = validName(filename); await access(handle);
        const previous = await deps.readRecord(), local = await deps.readState();
        let text = await read(handle, filename), fromDisk = text != null;
        if (!fromDisk) text = stateText(local);
        const parsed = CSV.parse(text); // validate fully before replacing browser state or creating a file
        if (!fromDisk) await write(handle, filename, text, true);
        const record = { handle, filename, expectedText: text, epoch: epoch(), lastSynced: now() };
        await deps.writeRecord(record);
        try { if (fromDisk) await deps.writeState(parsed, { reset: true }); }
        catch (e) { await deps.writeRecord(previous); throw e; }
        return { ok: true, status: await status(record), topics: parsed.index.length, exported: Object.keys(parsed.done).length };
      }),
      load: () => queue(async () => { const record = await deps.readRecord(); return record ? sync(record, true) : { ok: true, status: await status(null) }; }),
      save: (snapshot, expectedEpoch, expectedBase) => queue(async () => {
        const record = await deps.readRecord();
        if ((record?.epoch || null) !== (expectedEpoch || null)) return { ok: false, stale: true, status: await status(record, 'changed', 'The index folder changed. Reload TIPS before saving progress.') };
        if (typeof expectedBase === 'string' && expectedBase !== stateText(await deps.readState())) {
          return { ok: false, stale: true, error: 'Progress changed in another TIPS tab. The newer progress was kept; review the index before continuing.',
            status: await status(record, 'changed', 'Progress changed in another TIPS tab. Check & sync in Settings before continuing.') };
        }
        CSV.parse(stateText(snapshot));
        await deps.writeState(snapshot);
        return record ? sync(record, false) : { ok: true, status: await status(null) };
      }),
      disconnect: () => queue(async () => { await deps.writeRecord(null); return { ok: true, status: await status(null) }; }),
      status: () => queue(async () => { const record = await deps.readRecord(); return record ? { configured: true, folderName: record.handle.name, filename: record.filename, epoch: record.epoch, lastSynced: record.lastSynced } : disconnected(); })
    };
  }
  return { create, DEFAULT_FILE, validName };
});
