/* JSON-safe bounded transfers, incremental-update selection and the human-readable audit export. */
(function (root, factory) {
  const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.TIPSDocumentsClient = api;
})(globalThis, () => {
  const CHUNK = 262144;
  async function write(send, token, tips, version, file, cancelled) {
    const check = () => { if (cancelled()) throw Error('Folder update stopped.'); };
    check(); const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    check(); const started = await send('begin', { token, file: { tips, version, path: file.path, size: bytes.length, sha256 } });
    if (started.skip) return started;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      check(); let raw = ''; for (const b of bytes.subarray(offset, offset + CHUNK)) raw += String.fromCharCode(b);
      await send('chunk', { token, upload: started.upload, offset, data: btoa(raw) });
    }
    check(); return send('finish', { token, upload: started.upload });
  }
  function needsAttachments(topic, index) {
    if (!index) return false;
    const last = topic.last, known = last || topic.baseline;
    if (topic.create || last?.ok === false || topic.missingAttachments.length) return true;
    if (known && +known.version < +index.version) return true;
    // The loaded index is the source of change evidence. Do not recheck an archive
    // just because it predates attachment tracking or the scrub rules changed.
    const time = value => !value || value === '0' ? NaN : /^\d+$/.test(String(value)) ? +value : Date.parse(value);
    const baselineDate = +topic.baseline?.version === +known?.version ? topic.baseline?.mdate : null;
    const since = Number.isFinite(time(known?.mdate)) ? time(known.mdate) : time(baselineDate);
    if (known && +known.version === +index.version && time(index.mdate) > since) return true;
    return !topic.versions.includes(+index.version) && !last?.unavailable?.includes(+index.version);
  }
  function needsUpdate(topic, index) {
    if (!index) return false;
    if (needsAttachments(topic, index)) return true;
    for (let v = 1; v <= +index.version; v++) if (!topic.versions.includes(v) && !topic.last?.unavailable?.includes(v)) return true;
    return false;
  }
  function csv(inventory) {
    const cell = v => { let s = String(v ?? '').replace(/\r\n?|\n/g, ' '); if (/^[=+\-@\t]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const rows = [['tips','title','indexed_version','index_status','folder_status','folder_path','saved_versions','missing_versions','invalid_versions','saved_attachments','missing_tracked_attachments','notes']];
    for (const r of inventory.rows) rows.push([r.tips,r.title,r.indexedVersion,r.indexStatus,r.folderStatus,r.path,r.versions.join(';'),r.missing.join(';'),r.invalid.join(';'),r.attachments,r.missingAttachments.join(';'),r.notes.join(';')]);
    rows.push(['# Scan time',inventory.at], ['# Attachment verification',inventory.attachmentNote]);
    for (const issue of inventory.issues) rows.push(['# Scan issue',issue]);
    return rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  return { write, needsUpdate, needsAttachments, csv };
});
