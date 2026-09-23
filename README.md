# TIPS Exporter (Chrome extension)

This extension batch-exports XENTRY TIPS Reader topics. It runs inside your logged-in Chrome tab, so it never handles your password or sign-in. For each document it saves the current PDF, the raw data, attachments and links, the revision history, and a PDF of every prior version. Each batch becomes one zip, and nothing downloads until you approve the batch.

## Install (one time)

1. Unzip `TIPS_Exporter_extension.zip` into a folder you'll keep, for example `Documents\TIPS Exporter`.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select that folder.
4. Pin the extension to the toolbar (puzzle icon, then the pin).

## Continue where you left off (batches 1–3 already done)

1. Log into XENTRY and open **TIPS Reader**. A **⬇ TIPS Exporter** button appears in the bottom-right corner. Clicking the toolbar icon also shows or hides the panel.
2. Check the **Session** line. It should show your user, outlet and Reader version. If it shows ✗, open any topic once and click **⚙ → Re-detect**, or type the values in.
3. Click **Import log…** and select `_progress_log_all_documents.csv` from inside your newest zip (`TIPS_LI_Batch_003_of_139.zip`). The panel should show 3,469 topics, 75 exported, and next batch 4.
4. Optional: click **Check for new/updated**. New topics are added at the end, so earlier batch numbers never shift. Topics that got a newer version go back in the queue.
5. Click **Prepare batch 4**. When it's ready, review the summary (size, attachments, prior versions, errors), then click **Approve & download** or **Discard**.

## Moving the panel

Drag the black title bar (or the minimised **⬇ TIPS Exporter** button) anywhere on screen; the position is remembered. Double-click the title bar, or use **⚙ → Reset panel position**, to put it back in the bottom-right corner.

## Download a specific LI

Type one or more numbers in **Download specific LI**, e.g. `LI42.10-P-078779` (separate several with spaces, commas or new lines), then click **Download with revisions, attachments & links** (or Ctrl+Enter). Once the index is built, a unique fragment such as `078779` also works. The current version is always looked up live in TIPS. The download is saved immediately as `TIPS_LI42.10-P-078779.zip` (or `TIPS_selection_<date>_<n>docs.zip` for several) with the same folder layout as the batches: current PDF, JSON, Attachments and Links, and Revision History with every prior version. Single-LI downloads don't change bulk-export progress.

## Controls

| Control | What it does |
|---|---|
| Prepare batch N (next X docs) | Builds a zip of the next *batch-size* pending documents, in topic-number order. Takes about 2–4 minutes for 25 documents. |
| Pause / Resume / Cancel | Stops between documents. Cancel discards the partial batch. |
| Approve & download | Saves the zip to your Downloads folder and marks those documents as exported. |
| Discard | Throws away the prepared zip. Its documents stay pending. |
| After download, start preparing the next batch | On by default. You still approve each batch. |
| Auto-approve | Off by default. When on, every batch downloads without asking. |
| Check for new/updated | Adds new topics at the end and re-queues topics that have a newer version. |
| Import log… / Save log CSV | Restores progress from a CSV, or saves the current progress to one. The log is also included in every zip. |
| ⚙ Settings | Batch size (1–500, can be changed any time), delay between documents, outlet, user, Reader version, which data files to include, and reset panel position. |

Progress is tracked per document, not per batch. Changing the batch size never skips or repeats anything; the next batch is simply the next *N* pending documents. Zips from now on are named `TIPS_LI_Batch_NNN.zip`.

**Failed documents** stay *pending*, and the next Prepare picks them up again. **If your XENTRY session expires**, the batch stops with a warning. Log in again in the same tab, then click Prepare to retry the batch.

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

Progress is stored in the extension's own storage (`chrome.storage.local`), so clearing XENTRY's site data doesn't erase it. If you move to another PC or reinstall the extension, use **Import log…** with the newest zip's CSV.

## Troubleshooting

- **The button doesn't appear:** reload the TIPS Reader tab, or click the toolbar icon.
- **Every request fails after a XENTRY update:** set the new Reader version in ⚙. It's the `vX.Y.Z` shown at the top right of TIPS.
- **Chrome asks "Allow multiple downloads?":** click Allow for xentry.mercedes-benz.com.
