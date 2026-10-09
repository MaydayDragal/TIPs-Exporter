# Index Exceptions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current session. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Persist known version errors in the shared index and exclude them from routine requests and actionable scan counts.

**Architecture:** Add validated per-version records to index rows and a bounded acknowledgement journal in the documents connection. Reuse the existing index-save conflict checks. Keep exceptions distinct from successful downloads and bulk progress.

**Tech Stack:** Chrome Manifest V3, JavaScript, File System Access, IndexedDB, Node/jsdom tests.

**Spec:** `docs/superpowers/specs/2026-10-09-index-exceptions-design.md`

## Global Constraints

- Chrome 111 minimum; no new permissions or dependencies.
- Preserve index order, topic IDs, exported/pending status, source-conflict protection, GI/LI recognition, and all older PDFs and attachments.
- Exception handling applies to saved-folder updates; explicitly requested ZIP downloads retain their existing behaviour.

## Review Focus

- Legacy logs and same-installation migration preserve all existing progress and need no TIPS requests.
- CSV corruption or malformed exception data fails validation before index replacement.
- Temporary failures and scrub-engine initialization errors never become permanent exclusions.
- A failed index save or stale tab cannot discard unacknowledged exceptions or overwrite newer progress.
- A newer document version remains eligible while older excluded versions stay skipped.

## Task 1: Portable exceptions and inventory

**Files:** `index-csv.js`, `documents-client.js`, `documents-folder.js`, `tests/document-exceptions.test.js`.

**Interfaces:** `normalizeExceptions(value)` validates records; `applyExceptionEvents(index, events)` returns `{index, ids, changed}`; `classifyErrors(item, errors, at)` returns `{exceptions, remaining}`. Inventory adds `exceptions`, `exceptionEvents`, excluded-version counts, and required-document/version totals.

Also add `normalizeAttachmentInventory(value)` and `applyAttachmentInventories(index, updates) -> {index, changed}`. Inventory exposes local attachment observations for unique indexed folders. Save expected paths/sizes/timestamps in the optional `attachment_inventory` column; retain absent/changed expected entries. Test nested local files, zero network calls, cross-installation CSV restoration, and mismatches surviving repeated scans.

- [x] Write tests for nine/ten-column round trips, invalid data, permanent versus transient classification, exact screenshot-style version paths, seven excluded gaps, wholly excluded documents, and pending-event persistence.
- [x] Run the new tests and confirm failures before implementing.
- [x] Implement the schema, journal migration, and required-version inventory.
- [x] Run the focused tests to green.

## Task 2: Synchronization, selection, and retry

**Files:** `content.js`, `documents-background.js`, `background.js`, `documents-client.js`, `documents-folder.js`, `tests/documents-exceptions-ui.test.js`, existing document tests.

**Interfaces:** `topicDone` accepts validated `exceptions` and `resolvedVersions`, returns pending events. `ackExceptions(ids)` clears only acknowledged event IDs. Content `syncDocumentsIndex({exceptionEvents, attachmentUpdates})` uses `applyExceptionEvents` and the existing guarded index save. `updateDocuments({auto, retryExceptions})` targets only selected exceptions for explicit retries.

- [x] Write failing integration tests for migration to the shared CSV with zero requests, suppressed repeat errors, new versions, successful targeted retries, and index-write failure retention.
- [x] Implement event synchronization, exclusions in request selection, and the Index exceptions UI/report.
- [x] Verify old PDFs and attachments remain intact and bulk progress is unchanged.
- [x] Run all affected tests, then request a read-only review of the complete change.

## Task 3: Release

**Files:** `README.md`, `folder-settings.html`, `manifest.json` and the two design documents.

- [x] Document adjusted counts, supported failures, migration, and explicit retry; bump to 1.17.0.
- [x] Run `npm test` with zero failing checks, validate syntax/assets, and verify the ZIP excludes generated test output.
- [ ] Verify every remote release blob, publish with the expected main SHA and no force, then verify the new head.
- [ ] Provide the ZIP download link in chat.

Review addressed rejected browser-save acknowledgement, absent-folder attachment expectations, and unavailable metadata during explicit retries. Each has a production regression test. Focused domain/integration suites pass. Final `npm test`: 327 checks passed, 0 failed. All JavaScript syntax, manifest/Settings assets, and ZIP contents verified. Tests use production modules with simulated native filesystem/network boundaries; native Chrome was not available in this workspace. Publication and download delivery are recorded in chat after the release commit is published.
