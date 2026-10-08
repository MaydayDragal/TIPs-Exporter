# Persistent Index Folder Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline. Archive project: no git checkout; use the v1.14.0 ZIP as the immutable baseline.

**Goal:** Automatically load and update a reusable progress index in a user-selected local folder.

**Architecture:** A shared CSV codec handles the existing log format. A serialized repository owns folder reconciliation and Chrome storage. An extension Settings tab selects/grants access to a directory handle stored in extension IndexedDB. The content script requests load/save operations and displays folder status.

**Tech Stack:** Manifest V3, File System Access API, IndexedDB, Chrome runtime messaging/storage, vanilla JavaScript, Node/jsdom tests.

**Spec:** `docs/superpowers/specs/2026-10-07-index-folder-design.md`

## Global Constraints

- Chrome 111 minimum; no new broad permissions/native helper.
- Preserve PDF scrubbing, ZIP layout, optional files, and progress logs.
- Default file `_progress_log_all_documents.csv`; extension v1.15.0.
- No success status until writable.close and metadata persistence succeed.

## Review Focus

- Lost permission, write failure or missing disk file: retain browser progress and show unsaved status.
- Existing incompatible/corrupt CSV: refuse before altering either source.
- External edits plus unsaved local changes: conflict without overwriting either.
- Source change while export is busy or stale tab saving: no cross-folder overwrite.
- New installation, reload, and header-only file: predictable initialization and recovery.

## Task 1: CSV and directory repository

Files: `index-csv.js`, `index-folder.js`, `tests/index-folder.test.js`.
Interfaces: `TIPSIndexCsv.parse(text) -> {index,done}`, `stringify(index,done) -> string`; `TIPSIndexFolder.create(deps)` returns serialized `connect(handle,name)`, `load()`, `save(snapshot,epoch)`, `disconnect()`, `status()`. Dependencies read/write config, browser state and status.
- [x] Write tests for round-trip/empty CSV and reject bad schema/duplicates, load existing folder, create missing index, automatic save, permission/write failure, external change and conflict, restart retry, stale source saves, queued writes, disconnect.
- [x] Run tests RED, implement smallest complete repository, run GREEN.

## Task 2: Browser integration and Settings

Files: `folder-db.js`, `index-background.js`, `background.js`, `folder-settings.html/css/js`, `content.js`, `manifest.json`, existing test harnesses, `tests/index-folder-ui.test.js`.
- [x] Write UI/integration tests: picker click, selecting file, permission renewal, retained handle; content starts from disk before index use, approved batch saves and preparation does not; choosing/changing while busy is rejected.
- [x] Implement IDB handle storage and background messages with sender restrictions and source-change locks. Handles remain in IDB, never runtime JSON messages.
- [x] Implement folder page with current source/status, Choose folder, editable file selection, Use folder, Allow access, Reload from folder, Disconnect.
- [x] Hook content initialization and atomic progress commits. Present persistent folder status in Settings and Bulk, pause auto-continue on sync error. Keep manual import/export available.
- [x] Run focused tests GREEN and full `npm test`.

## Task 3: Review and delivery

- [x] Review against baseline and resolve concrete defects.
- [ ] Update README and create flat `TIPS-Exporter-v1.15.0.zip` with manifest at root; validate ZIP and every declared script.
- [ ] Replace the existing extension deliverable, preserving its Library identity and current version guard.

## Execution notes

Planning: folder selection is a native browser picker, not a typed absolute path. CSV contains index/progress only. User intent authorizes implementation; no additional design approval required. Existing archive is the isolated work product and needs no git initialization.

Task 1 complete: repository tests RED then GREEN (13 checks). Added optimistic concurrency based on the last loaded progress CSV so stale tabs cannot overwrite newer browser progress.
Task 2 focused checks complete: folder Settings/background/content integration 3 passing; PDF + layout suites 17 passing. Full npm test in progress. Archive baseline remains v1.14.0; no git repository exists.

Review: independent review found an approval gap before the progress write. A failing integration test reproduced a folder lock being granted while approval was in flight. The approval guard now spans retry, progress, and history persistence and releases in finally. The same regression-first protection covers manual CSV reads. Five Settings/content checks and 13 repository checks pass. No additional reviewer blockers; simultaneous writes from separate extension installations remain outside the documented single-installation scope.

The first complete suite found an older CSV compatibility regression (a quoted separator-only row). The codec now ignores empty separator rows while rejecting partial topic rows; the existing QA suite and focused codec tests pass. Final full-suite verification is in progress. Native Chrome permission persistence and live XENTRY behavior require manual validation; tests use mocked browser/runtime and filesystem boundaries.

Final verification: `npm test` completed with exit code 0, 248 checks passed and 0 failed across all 14 suites. Manifest 1.15.0 references were checked, changed JavaScript passed syntax checks, and the PDF scrubber/library bytes match v1.14.0. Release packaging and delivery follow these checks.
