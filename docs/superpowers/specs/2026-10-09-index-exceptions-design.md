# Per-version index exceptions

The user wants known unavailable TIPS versions and PDFs rejected by scrubbing recorded in the index, omitted from actionable scan totals, and skipped on routine updates. Preserve the catalogue, older files, the existing index folder, and the incremental request policy.

## Behaviour

- Add an optional `document_exceptions` JSON column to the progress CSV. Read existing nine-column logs without changes. Each record contains `version`, `kind` (`unavailable`, `scrub_failed`, or `retryable`), a sanitized `reason`, and `at`. Retryable records remain actionable and never exclude a PDF version.
- Exclude only the named PDF version. Newer versions and other missing files remain eligible. Temporary HTTP/network/session failures, missing scrub engine, missing folders, duplicates, and unclassified failures remain actionable.
- Inventory reports total catalogue documents separately from required documents/versions, completed required coverage, and excluded versions. A document with every expected version excluded is outside the required-document denominator only when it has no attachment expectations or retryable errors. An absent folder still reports its expected attachments. Exceptions never mark bulk-export progress as exported.
- Display an Index exceptions section listing document number, version, reason, and date. Include these fields in the inventory CSV.
- Routine updates make no requests solely for an excluded version. Explicit Retry excluded versions targets only exception documents and bypasses their version exclusions for that run. Successful saves remove the matching exception. Failures retain it. Existing invalid files remain preserved and require moving aside before replacement.
- Upgrade migration reuses previous `progress.unavailable` and the saved update error summary, including the user's two scrub-failure paths. This migration makes no network requests and is not hard-coded to document numbers.
- Retain pending exception events in the documents connection until the content script merges them into the normal index state and acknowledges their IDs. This protects migration and update results if a tab closes or an index conflict interrupts synchronization.
- Keep the error list current on every future update: record new failures, refresh their dates/reasons, clear a resolved PDF exception after saving, and clear retryable document errors after a successful attempt. Record a retryable failure without replacing a permanent exception for another file/version.

## Scope and constraints

The user also requested attachment indexing from the local archive. Extend the built-in Scan & verify tool rather than create a separate scanner. Add an optional `attachment_inventory` CSV column containing an observation date and attachment-relative paths, sizes, and last-modified times. Scan the configured attachment subtree locally, including nested files, without TIPS requests. Append newly observed paths to the expected manifest; retain missing prior entries and their expected sizes so a later scan cannot erase evidence of missing or changed files. Report these mismatches as actionable. Inventory metadata is not proof of online attachment completeness or a content hash.

Chrome 111 minimum; no new permissions or dependencies. The index CSV is authoritative after acknowledged events. Preserve index order, topic IDs, exported/pending status, source-conflict protection, GI/LI recognition, and all older PDFs and attachments. PDF checks remain filename/version/header checks, not page validation. Exception handling applies to saved-folder updates; explicitly requested ZIP downloads retain their existing behaviour.

## Components

- `index-csv.js`: exception/attachment validation, optional portable columns, deterministic event and attachment-inventory application by document number and topic ID.
- `documents-client.js`: classify only recognized permanent version failures, select requests with exclusions, export report columns.
- `documents-folder.js`: event journal and legacy migration, adjusted local inventory, planned-topic event recording and acknowledgement.
- `documents-background.js` / `background.js`: expose the trusted journal acknowledgement and load the shared client helper.
- `content.js`: synchronize events using the existing guarded index save, render exceptions, and perform explicit targeted retry.

Verification uses actual production modules with simulated native filesystem/network boundaries. No live TIPS crawling is needed.
