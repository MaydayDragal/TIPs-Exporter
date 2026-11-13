# LI Library layout, sync limits and page indicator (v1.21.0)

## Goal

Let the documents folder be the library that LI Organizer builds, so automatic sync files new and changed
documents straight into it, and stop a sync from asking TIPS for documents that have not changed.

## Library layout

LI Organizer keeps one folder per document inside a group folder:

```
54 Electrical and instruments/
    LI54.71-P-080956 - Title/
        LI54.71-P-080956_v8.pdf        newest version
        Older versions/                earlier versions (and their .json details files)
        Attachments and Links/
        Revision History/
```

The connection record gains `olderFolder` (`''` = the previous flat behaviour). All logic is in
`documents-folder.js`; `content.js` still sends `LI…_vN.pdf` and `Attachments and Links/name` paths.

| Step | Behaviour with `olderFolder` set |
|---|---|
| Scan | PDFs in `<document>/<olderFolder>` count as versions of that document. The subfolder is not walked as a nested document folder (which made every such document "duplicate"). |
| `begin` (PDF) | A version found in the subfolder is skipped, like one found in the document folder. New PDFs are always written to the document folder. |
| `topicDone` | `fileEarlier` moves every `_vN.pdf` / `_vN.json` below the newest version from the document folder into the subfolder: copy, compare size and SHA-256, then `removeEntry`. An identical copy already there just removes the original; a different valid file with the same name leaves both; an empty leftover is overwritten; an invalid PDF is never moved. A failure is logged and never fails the document. |
| `start` (new document) | Path is `<group folder>/<LI number - Title>`. The group folder is an existing root folder starting with the two-digit group, else `NN Name` from the built-in list, else `NN`. Archives whose document folders sit directly in the selected folder get no group folder. |

The Folders page sends `olderFolder` from a tick box and a name field. Choosing a folder that contains
`NN …` group folders ticks the box.

## Fewer requests

- `settings.libraryMaxDocuments` (default 50, 0 = none) slices the selected topics in `updateDocuments`;
  the result reports how many were held back.
- Scan: an expected attachment `{path, size}` is satisfied by any file of that size in the same name
  family: `name.ext`, `name (N).ext`, `name (vN[-M]).ext`. `begin` already compared contents within the
  `(vN)` family; it now includes `(N)` copies.
- `classifyErrors`: an attachment whose PDF cleanup fails as encrypted or unreadable is neither a version
  exception nor a retry reason. `PDF engine unavailable` stays retryable.

Background: after LI Organizer merged several archives, 768 PDF attachments existed as `name.pdf` (original)
and `name (2).pdf` (the cleaned copy this extension had saved). The index expected `name.pdf` at the cleaned
size, so every sync re-downloaded them and saved `name (vN).pdf`.

## Naming

`topicFolder` and the export base name no longer append ` (Requested)`. Existing folders with the label
are recognised by their document number as before.

## On the TIPS page

- `syncPill` inserts a `button.tipsx-sync` into `vehicle-navbar .navbar`, before `.tips-version-block`.
  It is re-inserted from `injectToolbar` when the Reader redraws the bar, and is on the mutation
  observer's ignore list. State comes from `S.lastCheck`, `S.documents`, `S.documentRun`, `S.checking`.
- `pageRefreshWanted` runs when `updateDocuments` ends, and in other tabs when the folder status leaves
  `running`. It reloads once per `lastCheck.at` (remembered in `sessionStorage`) when that check found
  new or updated topics, `settings.autoRefreshPage` is on, and the user is not typing, has no drawer or
  dialog open and nothing is running. Otherwise it retries every 15 s.

## Tests

`tests/library-layout.test.js` covers the layout, filing, new-document paths and name families.
`tests/browser/run-in-chrome.ps1` runs it together with `documents-folder` and `document-exceptions` in
headless Chrome through `tests/browser/node-shim.js`, for a PC without Node.js. Chrome prints the page at
load, so the shim replaces `Blob` and `crypto.subtle.digest` with stand-ins that answer immediately.

The tests that simulate the Reader (`npm test`) were updated for the new names but were not run for this
change; run them before the next release.
