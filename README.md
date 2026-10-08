# TIPS Exporter (Chrome extension)

TIPS Exporter downloads XENTRY TIPS Reader topics: the specific LI documents you pick, everything your current TIPS search found, or the whole catalogue in batches. For each topic it saves the selected PDF versions and attachments; revision history, document data and links lists are optional. It runs inside your logged-in TIPS tab, so it never sees your password, and it looks and works like part of TIPS.

**Version 1.15.0:** select a reusable index folder in Settings. The exporter loads its progress CSV when TIPS opens and saves changes back to that file automatically. Future installations can select the same folder to resume without importing a CSV. PDF scrubbing and the example-style ZIP layout remain available.

## Install

1. Download the supplied `TIPS-Exporter-v1.15.0.zip` and extract it to a permanent folder, for example `Documents\TIPS-Exporter-v1.15.0`. This package has `manifest.json` directly at its root, with no inner extension folder.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select the extracted folder that directly contains `manifest.json`. The extension card must show **1.15.0**.
4. Optional: pin the extension to the toolbar (puzzle icon, then the pin).

Needs Chrome 111 or newer.

**Updating:** unzip the new release to the same place (replacing the files), click the reload icon on TIPS Exporter in `chrome://extensions`, and reload the TIPS tab. Your session settings, PDF scrub rules, progress and recent downloads are kept. The previous all-data-files default switches to PDFs/attachments only on the first upgrade; custom file selections are preserved. You can re-enable any data files under **⚙ → Data files to include**. A batch or interrupted download prepared in the old layout must be prepared again; completed export progress is unchanged.

## Shared index folder

1. Open **⚙ → Index folder → Choose / change index folder…**. You can also open **Extension options** from the extension's Chrome Details page.
2. Click **Choose folder…** in the extension Settings tab. Select a permanent folder, such as `Documents\TIPS-Index`, outside the extension's installation folder, and allow read/write access.
3. Select the existing progress CSV in **Index filename**, or keep `_progress_log_all_documents.csv` to create a new one. When there are several CSV files, choose the index from the filename suggestions.
4. Click **Use this folder and index**. An existing index is validated and loaded automatically. If that filename does not exist, the current browser index/progress is written there, including an empty index if you have not built one yet.

The file is checked before loading the index when TIPS opens. Building an index, checking for new topics, importing a log, and approving a batch automatically update the same CSV. Preparing or discarding a batch does not mark its topics as exported. The CSV records LI numbers, versions, titles, index order, modification dates, exported/pending status, batch numbers and export dates; it does not copy session credentials or extension settings.

**Future versions:** updating the same unpacked extension in place retains the folder selection. A separate installation can select the same folder and CSV to restore progress. Chrome requires a folder picker; typing an absolute Windows path cannot grant access. If Chrome expires or revokes access, choose **Allow folder access** and then **Check & sync** in the folder Settings tab. Chrome may offer a persistent permission choice.

**When something goes wrong:** folder status appears in Settings and Bulk export. If permission is lost, the folder is unavailable, or a write fails, the newer progress stays in Chrome and auto-continue pauses. Restore access and choose **Check & sync** to save that pending progress. A missing configured index is not silently recreated; reconnect its folder/file to initialize it from the browser copy.

If the file was changed elsewhere and the browser also has unsaved changes, both copies are retained and a conflict is shown. Save the browser copy with **Bulk export → Save log** before deciding which one to keep. **Reload folder index** explicitly adopts the file and replaces cached progress after confirmation. Disconnect leaves the browser copy available. Finish or discard an active/prepared/interrupted export before switching or reloading the index source. An older tab cannot overwrite progress committed by another tab; review the newer index if a stale-tab message appears.

Only the selected CSV is updated. PDF/ZIP downloads still use Chrome's download location. Shared folder storage is intended for one active exporter installation at a time; it is not a multi-user database or a live filesystem watcher. Use **Check & sync** or reload TIPS to adopt changes made while the page was already open.

## Opening and closing

- In TIPS, open the **⋮** menu at the bottom of the left rail and choose **TIPS Exporter**.
- Or press **Alt+Shift+E** (change it at `chrome://extensions/shortcuts`), or click the extension's toolbar icon.

The exporter slides in from the right like a TIPS topic and dims the page. Close it with **✕**, by clicking the dimmed page, or with **Esc**. Downloads keep running while it's closed; the **⋮** button then shows a small badge (blue while working or waiting for you, green for a few seconds after a zip is saved), and the **TIPS Exporter** menu item shows the same status.

## Download LI documents

There are four ways, and they all produce the same zip.

**Type the numbers** (the **Single LI** tab)
1. Enter one or more LI numbers, e.g. `LI42.10-P-078779`, separated by spaces, commas or new lines. Once the bulk index is built, a unique ending such as `078779` also works.
2. Click **Look up** (or press Ctrl+Enter). Each entry is checked live in TIPS, so you always get the current version. The drawer shows the version and how many prior versions each has, and explains any entry it couldn't use.
3. Click **Download N**. The progress shows each document and the step it's on. **Cancel download** saves nothing.

**Use your current TIPS search.** Run a search in TIPS as usual (free text, function group, symptom, fault code…). The **Single LI** tab then offers **Your current TIPS search → Use search**, which lists every topic that search found (up to 300) ready to download. For bigger searches, narrow them down or use Bulk export.

**From the search results.** Every row in the TIPS results list gets a small **download** icon on its right edge. Clicking it opens a list of that topic's versions, newest first, with the date each was published (and the current version's reason for change):
- the current version is ticked; tick older ones too, or use **All** / **Current only**;
- untick **Include attachments** to leave out the attachments and links;
- click **Download**. Esc, **Cancel** or clicking elsewhere closes the list without downloading.

The zip name includes the LI number and shortened title, e.g. `LI42.10-P-078779 - Brake vibration_v5.zip` (the current version), `…_v3_v5.zip` or `…_no-attachments.zip`. Picking every version with attachments saves `LI42.10-P-078779 - Brake vibration.zip`.

**From the open topic.** A download button (with a small blue dot) appears in the topic's toolbar next to **Print**. It opens the same list of versions.

The zip is saved to your Downloads folder as `<LI number> - <Title>.zip`, or `TIPS_selection_<date>_<n>docs.zip` for several. Entries that were skipped are listed (and written to `_errors.txt` in the zip); **Fix** puts them back in the box.

**Recent downloads** keeps your last 10 downloads in this browser. **Check for updates** asks TIPS whether any of them has a newer version since you downloaded it; those are marked, with a **Download update** button. The ↻ button downloads the same documents again. Single-LI downloads never change bulk-export progress.

## Automatic PDF scrubbing

On by default for every export path: Single LI, search results, the open-topic toolbar, recent downloads, and bulk batches. It processes the current PDF, selected prior versions, and PDF attachments before saving them. PDF attachments are recognized by filename, response content type, or PDF file header. Other attachments retain their original bytes and names. Files inside attached ZIP archives are not unpacked or scrubbed.

Under **⚙ → PDF scrubbing**:

- **Automatically scrub PDFs before saving** enables or disables processing. Turning it off saves the original PDF bytes.
- **Remove the detected session user ID** is on by default and uses the User shown in Settings.
- **Remove the print date and time stamp** is on by default. It matches a separate text block containing a date such as `02-10-2026 13:55:18` (also `/` or `.` separators, optional seconds and AM/PM).
- **Additional text to remove** accepts one entry per line or comma-separated entries, matched without regard to case. It starts with `D7MASALL`, as in the supplied scrubber. Click **Save** after editing this text; changing a scrub checkbox also saves it.

While enabled, the scrubber always removes the PDF Info dictionary (author, title, producer, creator, dates and other fields), file ID, embedded XMP, PieceInfo application data and LastModified fields. It rewrites the PDF and drops unreachable objects so the replaced content streams and old metadata are not retained in the output. The PDF library is bundled in the extension; processing uses no CDN or external service and requests no additional extension permissions.

The scrubber keeps the supplied tool's text-block matching: all text in a matching `BT…ET` block is removed. Font and graphics-state operators are preserved so later text keeps its original appearance. Separate page-number and copyright blocks remain; if a PDF combines those with a matched ID in one block, all of that block's text is removed. This is not OCR or a general redaction tool: text drawn as an image or outlines, unusual font encodings, annotations, and data in non-PDF exports are outside its matching rules. No claim is made that arbitrary PDF attachments are fully anonymized. JSON/CSV exports are unchanged; use **Data files to include** to disable them if wanted.

**If a PDF cannot be processed**, including encrypted or damaged PDFs, it is omitted, with its filename and a reason in the existing errors display and `_errors.txt` / `_batch_NNN_errors.txt`. The original PDF is never substituted silently. Other files continue exporting. Affected bulk topics remain pending and auto-continue stops so the same failure does not loop. Export summaries show the number of PDFs scrubbed and text blocks removed, without logging the removed text or metadata values.

Scrub rules are fixed for an active/prepared/interrupted download. Finish or discard that download before changing them. Prepared ZIPs and interrupted downloads from older versions, or with different active scrub rules, must be prepared again; they are not approved with unprocessed PDFs. Your bulk progress and recent-download history remain intact.

## Bulk export

The **Bulk export** tab works through the whole catalogue in batches you approve one by one.

**Getting started**
- **First time:** click **Build index**. It reads the list of all topics from TIPS (run any search in TIPS first so the exporter can match the Reader's page size).
- **Continuing on another PC or after a reinstall:** select your existing folder and index CSV under **⚙ → Index folder**. Without a configured folder, click **Import log** and pick `_progress_log_all_documents.csv` from inside your newest batch zip. Progress, batch numbers and the next batch are restored.

Then click **Prepare batch N**. When it's ready, review the summary (size, attachments, prior versions, errors) and click **Approve & download** or **Discard**.

| Control | What it does |
|---|---|
| Prepare batch N | Builds a zip of the next *batch-size* pending documents, in topic-number order (about 2–4 minutes for 25). |
| Pause / Cancel | Stops between documents. Cancel discards the partial batch; its documents stay pending. |
| Approve & download | Saves the zip and marks those documents as exported. |
| Discard | Throws away the prepared zip; its documents stay pending. |
| Auto-continue | On by default: after each download, the next batch starts preparing (you still approve each one). |
| Auto-approve | Off by default. When on, every batch downloads without asking. |
| Check for new topics whenever TIPS loads | On by default. Every time TIPS is opened, reloaded or refreshed, the quick **Check new** runs by itself once your session is detected (usually one request). It stays silent when nothing changed; otherwise the **New in TIPS** popup opens and the drawer message starts with *When TIPS loaded*. Needs an index. |
| Check new | Reads only the most recently changed topics (newest first) and stops once it reaches topics already in your index, usually one request. Adds new topics at the end and re-queues exported topics that have a newer version. **Shift+click** compares every topic instead (the old, slow check). |
| Build / Rebuild index | Reads the full topic list. Rebuilding re-sorts everything and can shift batch numbers — use **Check new** unless you're starting over. |
| Import log / Save log | Restores progress from a CSV, or saves it to one. The log is also inside every batch zip. |

**New in TIPS popup.** Whenever TIPS loads and the automatic check finds new topics or new versions, a small **New in TIPS** window (in the TIPS look) lists them: LI number, title, date, and *New* or *v1 → v2* (with whether you had exported the old version). Click a topic to open it in TIPS, **Prepare N documents** to start a batch with them, or **Later** / Esc to close. Nothing new: no popup. The check looks back two weeks before the newest topic in your index, to catch topics that were published late.

Progress is tracked per document, so changing the batch size never skips or repeats anything. Failed documents stay pending and are picked up by the next batch. A document where only some files failed for a temporary reason (server or network trouble) is marked *incomplete*: it stays pending and is tried again in the next batch, up to 3 times; after that it counts as exported and the missing files are listed in that batch's errors file. Versions TIPS doesn't have are listed once and don't hold a document back.

## Interruptions, size and file names

- **If your XENTRY session ends mid-download,** the documents already finished are kept. The drawer shows **Download interrupted – N of M done**: log in again in the same tab (keep it open), then click **Resume** to continue where it stopped, or **Discard**.
  The exporter recognises an expired session whether TIPS answers with an error, redirects to the login page (also on another domain), or shows the login page instead of the document – and tells it apart from a network outage.
- **Reloading the page keeps your work:** a batch waiting for approval and an interrupted download are stored in the browser (IndexedDB) and come back after a reload or a fresh login, ready to approve or resume. Only a download that is actively running is lost on reload (Chrome asks first).
- **Zips stop at 400 MB,** because a zip is built in memory before it's saved. A bulk batch that reaches the limit is offered for review with what it has; the rest stay pending for the next batch. A single-LI download lists what didn't fit, and **Fix** puts those back in the box.
- **Folder and file names are shortened** (topic titles to 45 characters plus the LI number and `(Requested)` label, attachment names to 60, keeping the extension) so that unzipped paths stay well under Windows' 260-character limit.

## Request pacing

- **Index and search replays** use the same page size as the Reader's own search (learned from your searches in the tab; shown under **⚙**), one page every 0.3 s.
- **Between documents** the exporter waits a random time within the range under **⚙** (2–5 seconds by default), also between auto-continued batches. The progress line counts the wait down; Pause and Cancel work during it.

## What's inside each zip

The default single-topic ZIP matches this example:

```
LI00.00-P-066047 - Odor like crayon or vinegar entering the pass (Requested)/
    Attachments and Links/
        workshop instruction_EN.pdf
    LI00.00-P-066047_v1.pdf
    LI00.00-P-066047_v2.pdf
    LI00.00-P-066047_v3.pdf
    LI00.00-P-066047_v4.pdf
    LI00.00-P-066047_v5.pdf
    LI00.00-P-066047_v6.pdf
    LI00.00-P-066047_v7.pdf
```

Every topic in a selection or bulk batch uses the same layout. Folders are written first, then files in natural numeric order (`v1`, `v2`, … `v10`). ZIP viewers can apply their own sort order. PDFs keep their original LI/version filenames, and downloaded attachments keep their filenames subject to Windows-safe shortening and duplicate-name handling. Missing or failed PDFs are recorded in an errors text file.

Under **⚙ → Data files to include**, use **All**, **CSV only**, **JSON only**, **None**, or individual checkboxes. Optional document JSON goes beside the PDFs; optional revision history CSV/JSON goes in `Revision History`; the optional links CSV goes in `Attachments and Links`; the optional manifest goes at the ZIP root. Prior-version PDFs always stay beside the current PDF. A links list records references to other LIs; it does not download those referenced topics automatically.

Bulk ZIPs always retain `_progress_log_all_documents.csv` at the root so they can be resumed. Batch manifests are optional and error files appear only when something failed or was skipped. A successful single-topic export with **None** selected contains just PDFs and attachments, as in the example.

## Where things are stored

The selected index CSV is the portable copy of the topic index and export progress. Its directory handle and last synchronized contents are kept in extension-owned IndexedDB. Settings, cached bulk progress and recent downloads are kept in the extension's own storage (`chrome.storage.local`) in this browser, so clearing XENTRY's site data doesn't erase them. A prepared batch or an interrupted download is kept in the TIPS site's IndexedDB until you approve, resume or discard it (clearing XENTRY's site data removes it).

CSV files written by the exporter prefix any value starting with `=`, `+`, `-` or `@` with an apostrophe, so Excel never runs a title as a formula; **Import log** removes it again. The batch zips' progress log is your backup.

## Troubleshooting

- **Something doesn't seem to work:** open the exporter, click **⚙**, then **Check setup**. It lists what it found on the page (session, search page size, header, ⋮ menu, topic toolbar, TIPS fonts, Chrome version) and what to do about anything marked ✗.
- **TIPS Exporter isn't in the ⋮ menu, or the row / toolbar buttons don't appear:** reload the TIPS tab, or use Alt+Shift+E.
- **Every request fails after a XENTRY update:** set the new Reader version in ⚙ (the `vX.Y.Z` at the top right of TIPS).
- **Chrome asks "Allow multiple downloads?":** click Allow for xentry.mercedes-benz.com.

## Checking a new version

After updating, reload the extension and the TIPS tab, then check:

1. **⋮ → TIPS Exporter** (and Alt+Shift+E) open the drawer.
2. **⚙ → Check setup** shows ✓ for Session, Drawer position, ⋮ menu and TIPS fonts.
3. Open a topic: the button next to **Print** lists its versions; **Download 1 version** saves `<LI> - <Title>_v<N>.zip`.
4. In the results list, the row download icon lists the versions with the current one ticked; **Download 1 version** saves `<LI> - <Title>_v<N>.zip`.
5. After a search, **Use search** lists its topics.
6. Bulk export → **Check new** reports *No topics have changed…* or lists what it found.
7. In **Bulk export**, with batch size 2, prepare and approve a batch; the progress log updates.
8. Select an index folder in Settings. Approve a batch and verify its CSV updates; reload TIPS and confirm the same progress loads. Settings and recent downloads stay in Chrome.
9. **⚙ → PDF scrubbing** is enabled. Download a topic and open its PDF: the configured user ID and separate print timestamp should be gone, body content should remain, and the export summary should report PDFs scrubbed. Check prior versions and a PDF attachment too.

## For developers

The extension needs no build step: load the repository folder with **Load unpacked**. The tests simulate the TIPS Reader in [jsdom](https://github.com/jsdom/jsdom):

```
npm install
npm test
```

`vendor/pdf-lib.min.js` is the bundled, unmodified pdf-lib 1.17.1 UMD distribution; its MIT license is in `vendor/pdf-lib.LICENSE.md`. `pdf-scrubber.js` is adapted from the provided LI PDF Scrub HTML. The new PDF tests use real generated PDFs and inspect the PDFs extracted from the exported ZIPs. Existing endpoint simulation tests explicitly disable scrubbing because their dummy PDF responses contain only zero bytes.
