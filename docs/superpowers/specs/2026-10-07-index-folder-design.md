# Persistent index folder

The user wants an editable folder selection in Settings. The extension should find its index there, keep it updated, and let future installations select the same folder without importing a log.

Use an extension-owned Settings tab and Chrome's File System Access API. Store the directory handle in the extension's IndexedDB. Show a Choose/change folder control in the existing drawer's Settings. The default filename is `_progress_log_all_documents.csv`; allow selecting an existing progress CSV or editing the filename. This CSV is the existing portable index/progress format; unrelated settings and credentials do not go in it.

On selecting a folder/file, validate and load an existing index, or initialize a missing file from current browser progress. Load/check the configured file before the content script loads its index. After index construction, Check new, manual import, and approved batches, save index and done state atomically to Chrome storage, then overwrite the same CSV using createWritable/close. Preparing or discarding a batch must not mark it exported.

Remember the handle across extension reloads. A separate installation selects the same folder again. Chrome may require an Allow access click after permissions expire; show that state and retain unsaved browser progress. Only the selected index file is read/written. A manually entered filesystem path cannot grant access.

Keep the last synchronized CSV in IndexedDB. A changed disk file can be loaded if local progress has not changed; dirty local progress can be saved if disk is unchanged. If both changed, report a conflict and preserve both; the folder Settings page offers an explicit reload from the file. Invalid, missing, inaccessible, or unwritable files must never silently replace progress or report success. Serialize operations in the background worker. Guard source changes while an exporter tab is busy and reject stale saves after a source change.

Keep Chrome 111 minimum, existing PDF scrubbing, ZIP layout, batch logs, and offline browser-only behavior. Add no broad filesystem permission or native helper. Ship as v1.15.0.
