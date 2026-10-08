# Documents Folder Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, with one fresh whole-change review at the end.

**Goal:** Inventory an LI archive against its progress log and add missing PDFs/new attachment variants without overwriting older files.

**Architecture:** A filesystem repository handles inventory and serialized chunk writes. A service worker adapter authorizes Settings/content messages and recovers abandoned leases. A content client uses the existing exporter for authenticated fetches and PDF scrubbing; Settings selects the destination.

**Tech Stack:** Chrome MV3, File System Access, IndexedDB, runtime JSON messages, vanilla JavaScript, Node/jsdom.

**Spec:** `docs/superpowers/specs/2026-10-08-documents-folder-design.md`

## Global Constraints

- v1.16.0, Chrome 111 minimum, no new dependencies or permissions.
- Existing PDFs and attachments are preserved; changed attachment bytes get versioned sibling names.
- Default attachment subfolder: `Attachments and Links` (editable).
- Scan depth 8, 100,000 entries; chunks at most 256 KiB.
- No bulk progress/index mutation from document folder operations.
- Existing TIPS session and PDF scrub rules apply; failures are visible and retryable.

## Review Focus

- Duplicate LI folders, stale titles, nested batch folders and corrupt/empty PDFs: accurate inventory and no guessing.
- Same attachment filename with changed bytes or identical bytes under an earlier version suffix: preserve originals and avoid duplicates.
- Cancellation, lost permission and worker restart during a chunked write: no false completion or corrupt replacement.
- Stale tab/token/epoch, concurrent source changes and traversal: no cross-folder writes.
- Partial topic failures and an index with pending documents: no accidental claim that the full archive is verified or exported.

## Task 1: Folder repository and audit

Files: `documents-folder.js`, `tests/documents-folder.test.js`, `tests/helpers/memory-fs.js`.

Interface: `TIPSDocumentsFolder.create({db,writeStatus,now})`, with `connect(handle,options)`, `disconnect()`, `status()`, `inventory(snapshot)`, `start(token,owner,snapshot,options)`, `begin(token,owner,file)`, `chunk(token,owner,upload,offset,data)`, `finish(token,owner,upload)`, `topicStart(token,owner,tips)`, `topicDone(token,owner,result)`, `end(token,owner,summary)`, `abandon()` and `active()`. Snapshot is `{index,done}`. File is `{tips,path,version,size,sha256}`; `path` is a versioned PDF basename or `Attachments and Links/<name>`. A start response contains the inventory and planned topics, including existing paths/versions and last successful metadata.

- [x] Write failing tests for nested/title-independent discovery, expected/missing/pending/duplicate/invalid/extra inventory, incremental v5, immutable PDFs, attachment variants and same-content deduplication, traversal, bad chunk order, failed close, revoked access, stale source, and independent index state.
- [x] Run RED; implement repository; run GREEN.

## Task 2: Worker, Settings and content integration

Files: `documents-background.js`, `documents-client.js`, `documents-settings.js`, `background.js`, `manifest.json`, `folder-settings.html/css/js`, `index-background.js`, `content.js`, `tests/documents-ui.test.js`.

Interface: runtime type `documents-folder`; Settings-only connect/disconnect/configure; reader-only start/topic-start/begin/chunk/finish/topic-done/end; status/inventory/open available to trusted extension contexts. Binary client `TIPSDocumentsClient.write(send,token,tips,version,file,cancelled)` sends bounded chunks. The content script keeps a busy guard through scans/updates and answers `documents-folder-active` for lease recovery.

- [x] Write failing integration tests for folder choice/permission, authorized messages, the v4-to-v5 update, attachment preservation, inventory CSV and bulk progress isolation; verify auto updates after Check new and failure/stop recovery.
- [x] Implement worker ownership and recovery, settings controls, inventory/update UI and exporter reuse.
- [x] Run focused tests GREEN and the full existing suite.

## Task 3: Review and delivery

- [x] Update README with setup, inventory meaning, live attachment checks, preserved files and recovery.
- [x] Fresh review of the whole change; fix concrete important defects with regression tests.
- [x] Verify manifest/assets, syntax and complete suite; build an installable archive for validation.
- [ ] Commit/update the existing repository against its current expected head and verify remote files.

## Execution ledger

Baseline: `MaydayDragal/TIPs-Exporter` main `7d44d46905f8eb221cfe9578b15cc73818bddfdb`, matching the exact v1.15.0 archive. A separate archive-derived workspace provides isolation; publishing uses GitHub's guarded commit/ref API. No local git checkout exists, so no artificial local history is required.

Ruling: proceed inline under the user's existing instruction to modify this extension and update its repository; no repeated design or publication permission is needed. The user clarified that attachments must be preserved and inventory compared with the index. These requirements supersede the initial replace-changed-attachment proposal.

Pre-flight: Task 2 consumes Task 1's snapshot, planned topic, lease and file-transfer interfaces as written above. No conflicting interfaces found. The existing shared index repository remains separate.

Task 1: complete — repository RED (missing module), then GREEN (14 checks). Recovery regression tests reproduced worker-restart placeholders, writer-open failures and permission-loss lease retention; all three now pass (17 repository checks total). Cleanup metadata survives the worker and only removes its own still-empty unchanged placeholders.

Task 2: interfaces implemented — runtime integration RED (missing worker/client/settings), then GREEN (8 checks). Added real PDF scrubber success/failure coverage and opt-in missing-folder creation. Inventory CSV formula regression failed before escaping was added. The full suite is running.

Ruling: cancellation may wait for the current fetch to return; completed file writes remain. This matches the existing request machinery and is documented. Cost if wrong: delayed Stop responsiveness on an unresponsive server.

Ruling: repository publishing replaces per-task local commits because the isolated baseline is an archive, not a git checkout. The remote guarded commit preserves the actual history; local diffs are compared against the exact v1.15 archive. Cost if wrong: remote verification must catch baseline drift.

Task 2: complete — full npm test before final review: 276 checks passed, 0 failed. New integration covers Settings, inventory CSV, progress isolation, manual/automatic updates, attachment variants, missing-folder opt-in, real PDF scrubbing, cancellation, and JSON-safe transfer. All manifest assets and JavaScript syntax verified.

Final review: independent gpt-6-astra read-only review found three Important issues; no Critical or Minor findings. All three accepted by effect and fixed in one pass: (1) scan mixed container/topic trees fully and exclude ambiguous destinations; (2) persist an incomplete topic marker before search/fetch/write so failures or Stop after an earlier success remain retryable; (3) classify invalid PDFs as discrepancies even beyond the loaded index version. Regression tests reproduced the failures before fixes.

Final: Ruling: native Chrome permission/worker termination semantics were declined by the reviewer because a real Chrome runtime is unavailable. Use production-module integration tests with native-shaped filesystem boundaries and real PDF parsing, document the remaining browser check, and disclose it at delivery. Cost if wrong: browser-specific permission/lifecycle behavior may require a follow-up fix.

Final: fixed all three Important review findings — mixed-container identity, retry intent after success, and corrupt versions beyond the index — regression tests RED→GREEN. Final full npm test: 281 checks passed, 0 failed (19 repository, 14 documents integration, 248 existing checks). No deferred minors.

Release validation: v1.16.0 manifest, all referenced assets, JavaScript syntax, 49-file installable ZIP and per-file archive bytes verified. Publishing is gated on the verified baseline head 7d44d46905f8eb221cfe9578b15cc73818bddfdb and exact Git blob checks of the new remote tree; no force push.
