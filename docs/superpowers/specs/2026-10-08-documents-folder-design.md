# Incremental LI document folder and inventory

The user wants their existing LI archive updated in place: a newly released v5 belongs beside v1–v4, and newer attachments belong alongside older attachments. Existing attachments must never be replaced or deleted. They also want the selected folder scanned and checked against the loaded index/progress CSV.

## Storage and identity

Add a separate Documents folder connection in the extension Settings tab. Persist its native directory handle in extension IndexedDB. The editable attachment subfolder defaults to `Attachments and Links`, the layout previously supplied by the user. Reuse the existing Chrome folder permission/recovery pattern, with no new permissions or dependencies and Chrome 111 minimum.

Inventory the selected parent folder, including batch/container subdirectories (maximum depth 8 and 100,000 visited entries). Match a topic by its LI number, independent of its title. Read versioned PDFs in each topic folder and check for a nonempty PDF header. Duplicate LI folders, inaccessible folders, unexpected files, invalid PDFs, topics absent from the index, missing topics, and missing indexed PDF versions must be reported rather than silently counted as complete. Do not traverse attachment subfolders as independent topics.

Compare every index row, preserving exported/pending distinctions. Report missing LIs marked exported separately from LIs still pending in the log. The CSV does not contain an attachment manifest; offline verification must explicitly say that attachment completeness is checked against live TIPS during an update. Provide a downloadable inventory CSV with topic paths, saved/missing/invalid versions and discrepancies.

## Update behavior

Provide Scan & verify and Update saved LIs controls. A separate Include missing LIs from index checkbox permits creating missing topic folders during a manual update; automatic updates only target topics already present. Retain the existing folder names, including old titles. New folders use the established `<LI> - <title> (Requested)` layout.

For each selected topic, resolve its current TIPS version, download only absent versions, and fetch current attachments. Use the existing local PDF scrubber for every new PDF and PDF attachment. Scrub failures never fall back to original bytes. Existing nonempty PDFs and all existing attachments remain untouched. Invalid existing PDFs are reported for manual correction rather than overwritten.

Compare attachment content hashes with the original filename and its saved version variants. Identical bytes are skipped. A different attachment with an existing name is added as `<stem> (v5).<ext>`, then numbered variants if necessary. Retain attachments removed upstream and unrelated user files. Never delete or rename existing archive content.

After a successful Check new, automatically update existing saved topics that are new/stale in the folder inventory, have version gaps, or need a retry. Include modification dates and PDF rule changes in freshness checks. A manual update rechecks all selected topics and current attachment bytes, even without a version change. Filesystem updates do not mark bulk ZIP batches exported or otherwise alter the index log's progress.

## Boundaries and recovery

The content script owns authenticated TIPS requests and PDF scrubbing. The service worker owns folder handles, inventory and writes. Transfer binary files as sequential base64 chunks of at most 256 KiB because Chrome runtime messages use JSON. Native writable streams commit only after the complete file length is received and close succeeds.

One document update may own the folder at a time. Persist its token, source epoch, owner tab and topic paths; verify ownership on every write. Reject traversal and files outside the planned topic. Protect Settings source changes while a scan/update/export is active, and recover abandoned runs after their tab closes/reloads. A worker restart or lost permission stops the update with a retryable error; completed files remain. Stop cancels remaining work and aborts the current uncommitted write. Never report completion or a successful topic before the writes finish.

This is a single-installation local archive, not an operating-system-wide locking service. Scanning verifies names, versions and PDF headers; it does not prove that every PDF page is undamaged. Native Chrome permission behavior still needs a live-browser check.

Ship v1.16.0 to the existing GitHub repository. Preserve its history and update its expected head without force.
