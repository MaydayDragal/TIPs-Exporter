/* Append-only TIPS archive storage. Native handles and writable streams stay in the extension. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TIPSDocumentsFolder = api;
})(globalThis, () => {
  'use strict';
  // Match the normal Reader exporter's FULL_NO format, including GI as well as LI.
  const DOCUMENT_NO = /^[A-Z]{2}\d{2}\.\d{2}-[A-Z]-\d{6}$/i, PREFIX = /^([A-Z]{2}\d{2}\.\d{2}-[A-Z]-\d{6})(?=$|[\s_(.-])/i;
  const PDF = /^([A-Z]{2}\d{2}\.\d{2}-[A-Z]-\d{6})_v([1-9]\d*)\.pdf$/i;
  const KEY = 'documentsConnection', RUN = 'documentsRun', STATUS = 'documentsStatus', CHUNK = 262144;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function leaf(value) {
    const s = String(value || '');
    if (!s || s.length > 200 || s === '.' || s === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s)) throw Error('Invalid folder or filename. Use a name inside the selected folder.');
    return s;
  }
  function topicFolder(x) {
    const title = String(x.title || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 45).replace(/[. ]+$/, '');
    return `${x.tips.toUpperCase()}${title ? ' - ' + title : ''} (Requested)`;
  }
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  async function validPdf(file) { return file.size > 0 && new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer()).includes('%PDF-'); }
  async function entry(dir, name, kind, create = false) {
    const matches = []; for await (const x of dir.values()) if (x.name.toLowerCase() === name.toLowerCase()) matches.push(x);
    if (matches.length > 1) throw Error(`Ambiguous names in folder: ${name}`);
    if (matches.length) { if (matches[0].kind !== kind) throw Error(`A different file or folder already uses ${name}`); return matches[0]; }
    if (!create) return null;
    return kind === 'directory' ? dir.getDirectoryHandle(leaf(name), { create: true }) : dir.getFileHandle(leaf(name), { create: true });
  }
  async function subdir(root, path, create = false) { let d = root; for (const p of path ? path.split('/') : []) { d = await entry(d, leaf(p), 'directory', create); if (!d) throw Error(`Topic folder is missing: ${path}`); } return d; }
  function create({ db, writeStatus = async () => {}, now = () => new Date().toISOString() }) {
    let tail = Promise.resolve(); const uploads = new Map();
    async function emit(r, phase = 'ready', message = '', extra = {}) {
      const s = r ? { configured: true, folderName: r.handle.name, epoch: r.epoch, attachmentFolder: r.attachmentFolder, auto: r.auto,
        phase, message: message || 'Documents folder connected.', ...extra } : { configured: false, phase: 'disconnected', auto: false, message: 'Choose the parent folder containing your saved document folders (LI/GI).' };
      await db.put(STATUS, s); await writeStatus(s); return s;
    }
    const queue = fn => { const p = tail.then(fn).catch(async e => { try { await emit(await db.get(KEY), /permission|access|NotAllowed/i.test(e.message || e.name) ? 'permission' : 'error', e.message); } catch (_) {} throw e; }); tail = p.catch(() => {}); return p; };
    async function access(r) { if (!r) throw Error('Choose a documents folder in Settings first.'); if (await r.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw Error('Allow documents folder access in Settings, then try again.'); return r; }
    async function current() { return access(await db.get(KEY)); }
    async function lease(token, owner) {
      const r = await current(), run = await db.get(RUN);
      if (!run || run.token !== token || run.owner !== owner || run.epoch !== r.epoch) throw Error('This folder update expired or belongs to another tab. Start the update again.');
      return { r, run };
    }
    async function cleanupPending() {
      const pending = await db.get('documentsCleanup') || {};
      for (const [id, u] of Object.entries(pending)) {
        if (uploads.has(id)) continue;
        try {
          const f = await u.handle.getFile();
          if (f.size === 0 && f.lastModified === u.createdAt) await u.dir.removeEntry(u.name);
          delete pending[id]; // A completed/externally changed file is always preserved.
        } catch (e) { if (e.name === 'NotFoundError') delete pending[id]; }
      }
      await db.put('documentsCleanup', pending);
    }
    async function abortUpload(u) {
      try { await u.stream.abort(); } catch (_) {}
    }
    async function abandon() { for (const u of uploads.values()) await abortUpload(u); uploads.clear(); await cleanupPending(); await db.del(RUN); }
    async function scan(r, snapshot = {}) {
      const found = new Map(), issues = []; let visited = 0;
      async function walk(d, path, depth) {
        const list = []; for await (const x of d.values()) { if (++visited > 100000) throw Error('Folder scan exceeded 100,000 entries. Choose a more specific archive folder.'); list.push(x); }
        const hinted = PREFIX.exec(d.name)?.[1]?.toUpperCase();
        const pdfIds = [...new Set(list.filter(x => x.kind === 'file').map(x => PDF.exec(x.name)?.[1]?.toUpperCase()).filter(Boolean))];
        const tips = hinted || (pdfIds.length === 1 ? pdfIds[0] : null); let topic = null;
        if (tips && path) {
          const versions = [], invalid = [], notes = [], attachments = [], attachmentHandle = await entry(d, r.attachmentFolder, 'directory');
          for (const f of list) if (f.kind === 'file') {
            const m = PDF.exec(f.name); if (!m) continue;
            if (m[1].toUpperCase() !== tips) { notes.push(`Unexpected document PDF: ${f.name}`); continue; }
            const version = +m[2]; if (version > 10000) { notes.push(`Invalid PDF version: ${f.name}`); continue; }
            try { (await validPdf(await f.getFile()) ? versions : invalid).push(version); }
            catch (e) { invalid.push(version); notes.push(`Cannot read ${f.name}: ${e.message}`); }
          }
          if (attachmentHandle) for await (const f of attachmentHandle.values()) if (f.kind === 'file') { if (++visited > 100000) throw Error('Folder scan exceeded 100,000 entries.'); const file = await f.getFile(); attachments.push({ name: f.name, size: file.size }); }
          const last = r.progress?.[tips] || null;
          const missingAttachments = (last?.files || []).filter(f => !attachments.some(a => a.name.toLowerCase() === f.name.toLowerCase() && a.size === f.size)).map(f => f.name);
          topic = { tips, path, versions: [...new Set(versions)].sort((a,b) => a-b), invalid: [...new Set(invalid)].sort((a,b) => a-b), attachments: attachments.length, missingAttachments, notes, last };
          if (!found.has(tips)) found.set(tips, []); found.get(tips).push(topic);
        }
        if (!path && tips && pdfIds.length) throw Error('Select the parent containing the document folders, not an individual document folder.');
        if (!topic && pdfIds.length) issues.push(`Versioned PDFs outside a unique document folder: ${path || '(selected folder)'}`);
        let nested = 0;
        for (const child of list) if (child.kind === 'directory' && !child.name.startsWith('.') && !(topic && child.name.toLowerCase() === r.attachmentFolder.toLowerCase())) {
          if (depth >= 8) throw Error('Folder scan exceeded 8 nested levels. Choose a more specific archive folder.');
          nested += await walk(child, path ? path + '/' + child.name : child.name, depth + 1);
        }
        if (topic && nested) { topic.ambiguous = true; topic.notes.push('This folder also contains nested document folders. Move loose PDFs into their intended document folder before updating this location.'); }
        return nested + (topic ? 1 : 0);
      }
      await walk(r.handle, '', 0);
      const rows = [], indexed = new Map();
      const summary = { indexed: 0, found: 0, complete: 0, missingTopics: 0, missingExported: 0, pendingNotSaved: 0, versionGaps: 0, invalidPdfs: 0, duplicateTopics: 0, ambiguousTopics: 0, extraTopics: 0, missingAttachments: 0 };
      for (const [i, x] of (snapshot.index || []).entries()) {
        const tips = String(x.tips || '').toUpperCase(), v = +x.version;
        if (!DOCUMENT_NO.test(tips)) throw Error(`Index entry ${i + 1}: invalid document number "${tips || '(blank)'}". Expected a number such as LI00.00-P-066047 or GI72.12-P-053999.`);
        if (!Number.isSafeInteger(v) || v < 1 || v > 10000) throw Error(`Index entry ${i + 1}: invalid version "${x.version}" for ${tips}. Expected a whole number from 1 to 10000.`);
        if (indexed.has(tips)) throw Error(`Index entry ${i + 1}: duplicate document number ${tips} (also in entry ${indexed.get(tips)}). Resolve the duplicate in the index log before verifying this folder.`);
        indexed.set(tips, i + 1); summary.indexed++;
        const matches = found.get(tips) || [], t = matches.length === 1 ? matches[0] : null;
        const done = snapshot.done?.[x.tipsId], exported = !!done && (done.v == null || +done.v === v);
        const missing = []; for (let n = 1; n <= v; n++) if (!t?.versions.includes(n)) missing.push(n);
        const status = matches.length > 1 ? 'duplicate' : !t ? 'missing' : t.ambiguous ? 'ambiguous' : missing.length || t.invalid.length || t.missingAttachments.length || t.notes.length ? 'incomplete' : 'present';
        rows.push({ tips, title: x.title || '', indexedVersion: v, indexStatus: exported ? 'exported' : 'pending', folderStatus: status,
          path: t?.path || matches.map(f => f.path).join(' | '), versions: t?.versions || [], missing, invalid: t?.invalid || [], attachments: t?.attachments || 0,
          missingAttachments: t?.missingAttachments || [], notes: t?.notes || [] });
        if (matches.length > 1) summary.duplicateTopics++;
        else if (!t) { summary.missingTopics++; if (exported) summary.missingExported++; else summary.pendingNotSaved++; }
        else { summary.found++; if (status === 'present') summary.complete++; if (t.ambiguous) summary.ambiguousTopics++; summary.versionGaps += missing.length; summary.invalidPdfs += t.invalid.length; summary.missingAttachments += t.missingAttachments.length; }
      }
      for (const [tips, matches] of found) if (!indexed.has(tips)) {
        summary.extraTopics++; if (matches.length > 1) summary.duplicateTopics++;
        if (matches.length === 1 && matches[0].ambiguous) summary.ambiguousTopics++;
        rows.push({ tips, title: '', indexedVersion: null, indexStatus: 'not in index', folderStatus: matches.length > 1 ? 'duplicate' : matches[0].ambiguous ? 'ambiguous' : 'not in index', path: matches.map(f => f.path).join(' | '), versions: matches[0].versions, missing: [], invalid: matches[0].invalid, attachments: matches[0].attachments, missingAttachments: matches[0].missingAttachments, notes: matches[0].notes });
      }
      return { rows, summary, issues, at: now(), topics: [...found.values()].filter(a => a.length === 1 && !a[0].ambiguous).map(a => a[0]),
        attachmentNote: 'The index log lists PDF versions, not attachment filenames. Previously tracked attachments are checked locally; current attachment completeness is checked against live TIPS during an update.' };
    }
    async function remember(run, tips, item) { run.fileRecords ||= {}; const a = run.fileRecords[tips] ||= []; const old = a.findIndex(x => x.name.toLowerCase() === item.name.toLowerCase()); if (old >= 0) a.splice(old, 1); a.push(item); await db.put(RUN, run); }
    return {
      connect: (handle, options = {}) => queue(async () => {
        const attachmentFolder = leaf(options.attachmentFolder || 'Attachments and Links');
        if (await db.get(RUN)) throw Error('A folder update is running. Stop it before changing folders.');
        const r = { handle, attachmentFolder, auto: options.auto !== false, epoch: crypto.randomUUID(), progress: {} };
        await access(r); await db.put(KEY, r); return emit(r);
      }),
      configure: options => queue(async () => {
        if (await db.get(RUN)) throw Error('A folder update is running. Stop it before changing folder settings.');
        const r = await current(); r.attachmentFolder = leaf(options.attachmentFolder || r.attachmentFolder); r.auto = options.auto !== false; await db.put(KEY, r); return emit(r);
      }),
      disconnect: () => queue(async () => { if (await db.get(RUN)) throw Error('A folder update is running. Stop it first.'); await db.del(KEY); return emit(null); }),
      status: () => queue(async () => await db.get(STATUS) || emit(await db.get(KEY))),
      active: () => queue(() => db.get(RUN)),
      abandon: () => queue(abandon),
      inventory: snapshot => queue(async () => { const r = await current(); await cleanupPending(); const inventory = await scan(r, snapshot); await emit(r, 'ready', 'Folder scanned against the index. See the inventory for missing or invalid files.', { inventory: inventory.summary }); return inventory; }),
      start: (token, owner, snapshot, options = {}) => queue(async () => {
        if (!/^[\w-]{1,80}$/.test(token) || !Number.isInteger(owner)) throw Error('Invalid update owner or token.');
        if (await db.get(RUN)) throw Error('A documents folder update is already running in another tab.');
        const r = await current(); await cleanupPending(); const inventory = await scan(r, snapshot), topics = inventory.topics.map(t => ({ ...t, create: false }));
        if (options.includeMissing && !options.auto) for (const x of snapshot.index || []) if (inventory.rows.find(a => a.tips === x.tips.toUpperCase())?.folderStatus === 'missing') topics.push({ tips: x.tips.toUpperCase(), path: topicFolder(x), versions: [], invalid: [], missingAttachments: [], notes: [], create: true, last: null });
        await db.put(RUN, { token, owner, epoch: r.epoch, topics, fileRecords: {} }); await emit(r, 'running', 'Updating saved documents…'); return { token, topics, inventory };
      }),
      begin: (token, owner, file) => queue(async () => {
        const { r, run } = await lease(token, owner), topic = run.topics.find(t => t.tips === file.tips);
        if (!topic) throw Error('This topic was not planned for the folder update.');
        if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 512 * 1048576 || !/^[a-f0-9]{64}$/.test(file.sha256 || '') || !Number.isInteger(file.version) || file.version < 1 || file.version > 10000) throw Error('Invalid file size, checksum or version.');
        const parts = String(file.path || '').split('/'), pm = parts.length === 1 && PDF.exec(parts[0]);
        const isPdf = !!pm && pm[1].toUpperCase() === topic.tips;
        if (!isPdf && (parts.length !== 2 || parts[0] !== 'Attachments and Links')) throw Error('File path is not allowed in this topic.');
        let name = leaf(parts.at(-1)), d = await subdir(r.handle, topic.path, topic.create), relative = '';
        if (!isPdf) { d = await entry(d, r.attachmentFolder, 'directory', true); relative = r.attachmentFolder + '/'; }
        if (isPdf) {
          const existing = await entry(d, name, 'file');
          if (existing) { if (!await validPdf(await existing.getFile())) throw Error(`${name}: existing PDF is empty or invalid; it was preserved. Move it aside to download a replacement.`); return { skip: true, path: existing.name, kind: 'pdf' }; }
        } else {
          const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
          const family = new RegExp('^' + esc(stem) + '(?: \\(v[0-9]+(?:-[0-9]+)?\\))?' + esc(ext) + '$', 'i');
          for await (const f of d.values()) if (f.kind === 'file' && family.test(f.name)) {
            const old = await f.getFile();
            if (old.size === file.size && await digest(await old.arrayBuffer()) === file.sha256) { await remember(run, topic.tips, { name: f.name, size: file.size, sha256: file.sha256 }); return { skip: true, path: relative + f.name, kind: 'attachment' }; }
          }
          if (await entry(d, name, 'file')) { let n = 1; do { name = leaf(`${stem} (v${file.version}${n > 1 ? '-' + n : ''})${ext}`); n++; } while (await entry(d, name, 'file')); }
        }
        const handle = await entry(d, name, 'file', true), before = await handle.getFile();
        if (before.size) throw Error(`${name} appeared during the update; it was preserved. Retry after other file operations finish.`);
        // Persist cleanup metadata before opening the writer, so a worker restart is retryable.
        const upload = crypto.randomUUID(), pending = await db.get('documentsCleanup') || {};
        pending[upload] = { handle, dir: d, name, createdAt: before.lastModified }; await db.put('documentsCleanup', pending);
        let stream;
        try { stream = await handle.createWritable(); } catch (e) { await cleanupPending(); throw e; }
        uploads.set(upload, { token, owner, tips: topic.tips, dir: d, handle, name, path: relative + name, kind: isPdf ? 'pdf' : 'attachment', stream, createdAt: before.lastModified, offset: 0, size: file.size, sha256: file.sha256 });
        return { upload, path: relative + name, kind: isPdf ? 'pdf' : 'attachment' };
      }),
      chunk: (token, owner, id, offset, data) => queue(async () => {
        await lease(token, owner); const u = uploads.get(id);
        if (!u || u.token !== token || u.owner !== owner) throw Error('The file writer expired. Start the update again.');
        if (offset !== u.offset) throw Error('File chunks arrived out of order.');
        if (typeof data !== 'string' || data.length > 4 * Math.ceil(CHUNK / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('Invalid file chunk.');
        const raw = atob(data), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
        if (!bytes.length || bytes.length > CHUNK || u.offset + bytes.length > u.size) throw Error('File chunk exceeds its declared size.');
        await u.stream.write(bytes); u.offset += bytes.length; return { offset: u.offset };
      }),
      finish: (token, owner, id) => queue(async () => {
        const { run } = await lease(token, owner), u = uploads.get(id);
        if (!u || u.token !== token || u.owner !== owner || u.offset !== u.size) throw Error('The complete file has not been received.');
        try { await u.stream.close(); } catch (e) { await abortUpload(u); uploads.delete(id); await cleanupPending(); throw e; }
        uploads.delete(id); await cleanupPending(); if (u.kind === 'attachment') await remember(run, u.tips, { name: u.name, size: u.size, sha256: u.sha256 });
        return { written: true, path: u.path, kind: u.kind };
      }),
      topicStart: (token, owner, tips) => queue(async () => {
        const { r, run } = await lease(token, owner); if (!run.topics.some(t => t.tips === tips)) throw Error('Unplanned topic.');
        r.progress[tips] = { ...r.progress[tips], ok: false, at: now() };
        await db.put(KEY, r); return { saved: true };
      }),
      topicDone: (token, owner, result) => queue(async () => {
        const { r, run } = await lease(token, owner); if (!run.topics.some(t => t.tips === result.tips)) throw Error('Unplanned topic.');
        if ([...uploads.values()].some(u => u.token === token && u.tips === result.tips)) throw Error('A topic still has an unfinished file.');
        const old = r.progress[result.tips] || {}, files = new Map((old.files || []).map(x => [x.name.toLowerCase(), x]));
        for (const f of run.fileRecords[result.tips] || []) files.set(f.name.toLowerCase(), f);
        r.progress[result.tips] = { version: +result.version, mdate: String(result.mdate || ''), policy: String(result.policy || ''), ok: !!result.ok, unavailable: result.unavailable || [], files: [...files.values()], at: now() };
        await db.put(KEY, r); return { saved: true };
      }),
      end: (token, owner, summary = {}) => queue(async () => {
        // Ending a lease must remain possible after filesystem permission is revoked.
        const r = await db.get(KEY), run = await db.get(RUN);
        if (!run || run.token !== token || run.owner !== owner || run.epoch !== r?.epoch) throw Error('This folder update expired or belongs to another tab.');
        await abandon();
        const errors = (summary.errors || []).slice(0, 100), phase = summary.cancelled ? 'stopped' : errors.length ? 'error' : 'saved';
        const message = summary.cancelled ? 'Update stopped. Completed files were kept; run it again to continue.' : errors.length ? 'Some files need attention. Completed files and older attachments were kept.' : 'Documents folder update finished. Existing files were preserved.';
        return emit(r, phase, message, { summary: { ...summary, errors }, lastUpdated: now() });
      }),
      reportError: error => queue(async () => emit(await db.get(KEY), /access|permission|NotAllowed/i.test(String(error)) ? 'permission' : 'error', String(error)))
    };
  }
  return { create, CHUNK, leaf, topicFolder };
});
