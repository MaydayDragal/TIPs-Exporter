# TIPS Exporter (Chrome extension)

This extension downloads XENTRY TIPS Reader topics, either the specific LI documents you ask for or the whole catalogue in batches, and your TIPS cases as readable reports with their files. It runs inside your logged-in Chrome tab, so it never handles your password or sign-in. For each document it saves the current PDF, the raw data, attachments and links, the revision history, and a PDF of every prior version. Bulk batches become one zip each, and nothing downloads until you approve the batch.

## Install (one time)

1. Unzip `TIPS_Exporter_extension.zip` into a folder you'll keep, for example `Documents\TIPS Exporter`.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select that folder.
4. Pin the extension to the toolbar (puzzle icon, then the pin).

Needs Chrome 111 or newer.

## Continue where you left off (batches 1–3 already done)

1. Log into XENTRY and open **TIPS Reader**. Open the **⋮** menu at the bottom of the left rail and choose **TIPS Exporter** (or click the extension's toolbar icon). The exporter opens as a drawer on the right, like a TIPS topic.
2. Check the session line at the bottom of the drawer. It should show your user, outlet and Reader version. If it says the session isn't detected, open any topic once and click **⚙ → Re-detect session**, or type the values in.
3. The drawer opens on the **Single LI** tab. Switch to the **Bulk export** tab, then click **Import log** and select `_progress_log_all_documents.csv` from inside your newest zip (`TIPS_LI_Batch_003_of_139.zip`). It should show 3,469 topics, 75 exported, and next batch 4.
4. Optional: click **Check new**. New topics are added at the end, so earlier batch numbers never shift. Topics that got a newer version go back in the queue.
5. Click **Prepare batch 4**. When it's ready, review the summary (size, attachments, prior versions, errors), then click **Approve & download** or **Discard**.

## Opening and closing

Open the exporter from the Reader's **⋮** menu (bottom of the left rail) → **TIPS Exporter**, or with the extension's toolbar icon. It slides in from the right like a TIPS topic and dims the page. Close it with **✕**, by clicking the dimmed page, or with **Esc**.

Downloads and batches keep running while the drawer is closed. The **⋮** button then shows a small badge: blue while something is downloading or a batch is waiting for approval, green for a few seconds after a zip is saved. The **TIPS Exporter** menu item shows the same status.

## Download a specific LI

This is the **Single LI** tab, the drawer's main screen.

1. Type one or more numbers in **Download LI documents**, e.g. `LI42.10-P-078779`. Separate several with spaces, commas or new lines. Once the index is built, a unique ending such as `078779` also works.
2. Click **Look up** (or press Ctrl+Enter). Each entry is checked live in TIPS, so you always get the current version. The drawer lists what it found, with the version and how many prior versions it has, and explains any entry it couldn't use (for example, a fragment that matches several topics). Editing the box clears the list so you can look up again.
3. Click **Download N** at the bottom of the drawer. The progress shows each document and the step it's on (topic data and PDF, attachments, prior versions). **Cancel download** saves nothing.
4. The zip is saved straight to your Downloads folder as `TIPS_LI42.10-P-078779.zip`, or `TIPS_selection_<date>_<n>docs.zip` for several. It has the same folder layout as the batches: current PDF, JSON, Attachments and Links, and Revision History with every prior version. Skipped entries are listed and also written to `_errors.txt` in the zip; **Fix** puts them back in the box.

### From the topic itself

When you open a topic in TIPS, a download button (with a small blue dot) appears in the topic's toolbar, next to **Print**. Hover over it to see what you'll get, e.g. "Download LI42.10-P-078779 with all 5 prior versions, attachments and links". Click it to download straight away: no typing, no lookup step. The button spins while it works and then shows a green tick, and the **⋮** button shows the downloading, then saved, badge. The zip is the same as a download from the drawer. If TIPS changes its layout and the button stops appearing, use the drawer as usual.

**Recent downloads** keeps your last 10 downloads in this browser. The ↻ button looks the same documents up again. Single-LI downloads never change bulk-export progress.

## Download cases

The **Cases** tab downloads your TIPS cases, one or several at a time. It only reads cases; it never sends, closes or changes anything.

1. Type one or more case numbers (9 digits, the **Case number** shown in an open case), separated by spaces, commas or new lines, and click **Look up**. Each case shows its title, status, vehicle, and how many files and messages it has.
2. Click **Download N**. You get `TIPS_Case_<number>.zip` (or `TIPS_Cases_<date>_<n>cases.zip` for several), with one folder per case:

```
Case <number> - <title>/
    Case report.html     vehicle, fault codes, summary, complaint, measures, result and the message history
    Attachments/         every file uploaded to the case
```

The report opens in any browser and prints cleanly. Its message history shows what TIPS shows the workshop, in date order, with each uploaded file linked to its saved copy. Messages that TIPS keeps internal to workshop support and headquarters, and internal notes, are left out.

When a case is open in TIPS, the same download button as for topics appears next to **Print** in the case's toolbar.

## Controls

Bulk export has its own tab in the drawer. The main button for each step (Prepare, Approve & download, Pause…) is at the bottom of the drawer. While a batch is running or waiting for approval, single-LI downloads are locked.

| Control | What it does |
|---|---|
| Prepare batch N (next X docs) | Builds a zip of the next *batch-size* pending documents, in topic-number order. Takes about 2–4 minutes for 25 documents. |
| Pause / Resume / Cancel | Stops between documents. Cancel discards the partial batch. |
| Approve & download | Saves the zip to your Downloads folder and marks those documents as exported. |
| Discard | Throws away the prepared zip. Its documents stay pending. |
| Auto-continue | On by default: after each download, the next batch starts preparing. You still approve each batch. |
| Auto-approve | Off by default. When on, every batch downloads without asking. |
| Check new | Adds new topics at the end and re-queues topics that have a newer version. |
| Rebuild / Build index | Builds the list of all topics from TIPS. Rebuilding re-sorts everything and can shift batch numbers, so use **Check new** instead unless you're starting over. |
| Import log / Save log | Restores progress from a CSV, or saves the current progress to one. The log is also included in every zip. |
| ⚙ Settings | Batch size (1–500, can be changed any time), delay between documents (a random time within a range, 2–5 seconds by default), search page size, outlet, user, Reader version, and which data files to include. |

Progress is tracked per document, not per batch. Changing the batch size never skips or repeats anything; the next batch is simply the next *N* pending documents. Zips from now on are named `TIPS_LI_Batch_NNN.zip`.

**Failed documents** stay *pending*, and the next Prepare picks them up again. **If your XENTRY session expires**, the batch stops with a warning. Log in again in the same tab, then click Prepare to retry the batch.

## Request pacing

- **Index search.** **Build index** and **Check new** run one search pass, oldest topics first, using the same page size as the Reader's own search. The exporter learns that page size by watching the Reader's searches in the tab, so run any search in TIPS first. Until it has seen one, it asks before falling back to 50 per page. The page size and where it came from are shown under **⚙**. If you type a size in yourself, it is kept until you click **Re-detect session**.
- **Between documents.** The exporter waits a random time within the range set under **⚙** (2–5 seconds by default) before each document after the first. The progress line counts the wait down, and Pause and Cancel work during it. A batch of 25 takes about 1½ minutes longer than with the old fixed 0.25 s delay.

## What's inside each zip

```
_progress_log_all_documents.csv   every topic: exported / pending (import this to resume)
_batch_NNN_manifest.csv           per doc: version, attachments, links, prior versions, status
_batch_NNN_errors.txt             only if something failed
LIxx.xx-P-xxxxxx - <Title>/
    LIxx…_vN.pdf  LIxx…_vN.json
    Attachments and Links/        attachments + _attachments_and_links.csv (only if any)
    Revision History/             revision_history.csv/.json + LIxx…_v1.pdf … v(N-1).pdf
```

## Choosing .json / .csv files

Under **⚙ → Data files to include** you can switch each data file on or off: document data `.json`, revision history `.csv`, revision history `.json`, attachments & links list `.csv`, and batch manifest `.csv`. The **All**, **CSV only**, **JSON only** and **None** buttons set them all at once. Changes are saved immediately and apply to the next batch and to specific-LI downloads. PDFs (current and prior versions) and attachments are always saved. `_progress_log_all_documents.csv` is always included because it's needed to resume. Links to other LIs are only recorded in the attachments & links CSV, so switching that off drops them.

## Where progress is stored

Progress is stored in the extension's own storage (`chrome.storage.local`), so clearing XENTRY's site data doesn't erase it. If you move to another PC or reinstall the extension, use **Import log** (Bulk export screen) with the newest zip's CSV.

## Troubleshooting

- **Something doesn't seem to work:** open the exporter, click **⚙**, then **Check setup**. It lists what the exporter found on the page (session, search page size, header, ⋮ menu, topic toolbar, TIPS fonts, Chrome version) and what to do about anything marked ✗.
- **TIPS Exporter isn't in the ⋮ menu, or the toolbar button doesn't appear:** reload the TIPS Reader tab, or click the extension's toolbar icon.
- **Every request fails after a XENTRY update:** set the new Reader version in ⚙. It's the `vX.Y.Z` shown at the top right of TIPS.
- **Chrome asks "Allow multiple downloads?":** click Allow for xentry.mercedes-benz.com.

## Checking a new version

After installing an update, reload the extension in `chrome://extensions`, reload the TIPS tab, and check:

1. **⋮ → TIPS Exporter** opens the drawer and the ⋮ menu closes.
2. **⚙ → Check setup** shows ✓ for Session, Drawer position, ⋮ menu and TIPS fonts.
3. Open a topic: the download button appears next to **Print**; clicking it saves `TIPS_<LI>.zip` for that topic, and the ⋮ button shows the green badge.
4. In **Single LI**, look up two LI numbers and download them; the zip has both folders.
5. Open a case: the download button appears next to **Print**; the zip has `Case report.html` and the case's files.
6. In **Bulk export**, set the batch size to 2 under ⚙, prepare a batch, approve it, and check the progress log updates.
7. Reload TIPS: your settings and progress are still there.

