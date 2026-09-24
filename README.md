# TIPS Exporter (Chrome extension)

TIPS Exporter downloads XENTRY TIPS Reader topics: the specific LI documents you pick, everything your current TIPS search found, or the whole catalogue in batches. For each topic it saves the current PDF, every prior version, the revision history, attachments and links. It runs inside your logged-in TIPS tab, so it never sees your password, and it looks and works like part of TIPS.

## Install

1. Download `TIPS-Exporter-vX.Y.Z.zip` from the [latest release](https://github.com/MaydayDragal/TIPs-Exporter/releases/latest) and unzip it into a folder you'll keep, for example `Documents\TIPS Exporter`.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select that folder.
4. Optional: pin the extension to the toolbar (puzzle icon, then the pin).

Needs Chrome 111 or newer.

**Updating:** unzip the new release over the same folder, click the reload icon on TIPS Exporter in `chrome://extensions`, and reload the TIPS tab. Your settings, progress and recent downloads are kept.

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

**From the search results.** Every row in the TIPS results list gets two small controls on its right edge:
- the **download** icon saves that topic straight away;
- the **tick box** selects it. A bar appears at the bottom of the page — **N selected · Clear · Download N** — which downloads all ticked topics together.

**From the open topic.** A download button (with a small blue dot) appears in the topic's toolbar next to **Print**. Hover to see what you'll get; click to download straight away.

The zip is saved to your Downloads folder as `TIPS_LI42.10-P-078779.zip`, or `TIPS_selection_<date>_<n>docs.zip` for several. Entries that were skipped are listed (and written to `_errors.txt` in the zip); **Fix** puts them back in the box.

**Recent downloads** keeps your last 10 downloads in this browser. **Check for updates** asks TIPS whether any of them has a newer version since you downloaded it; those are marked, with a **Download update** button. The ↻ button downloads the same documents again. Single-LI downloads never change bulk-export progress.

## Bulk export

The **Bulk export** tab works through the whole catalogue in batches you approve one by one.

**Getting started**
- **First time:** click **Build index**. It reads the list of all topics from TIPS (run any search in TIPS first so the exporter can match the Reader's page size).
- **Continuing on another PC or after a reinstall:** click **Import log** and pick `_progress_log_all_documents.csv` from inside your newest batch zip. Progress, batch numbers and the next batch are restored.

Then click **Prepare batch N**. When it's ready, review the summary (size, attachments, prior versions, errors) and click **Approve & download** or **Discard**.

| Control | What it does |
|---|---|
| Prepare batch N | Builds a zip of the next *batch-size* pending documents, in topic-number order (about 2–4 minutes for 25). |
| Pause / Cancel | Stops between documents. Cancel discards the partial batch; its documents stay pending. |
| Approve & download | Saves the zip and marks those documents as exported. |
| Discard | Throws away the prepared zip; its documents stay pending. |
| Auto-continue | On by default: after each download, the next batch starts preparing (you still approve each one). |
| Auto-approve | Off by default. When on, every batch downloads without asking. |
| Check new | Adds new topics at the end and re-queues exported topics that have a newer version. |
| Build / Rebuild index | Reads the full topic list. Rebuilding re-sorts everything and can shift batch numbers — use **Check new** unless you're starting over. |
| Import log / Save log | Restores progress from a CSV, or saves it to one. The log is also inside every batch zip. |

Progress is tracked per document, so changing the batch size never skips or repeats anything. Failed documents stay pending and are picked up by the next batch.

## Interruptions, size and file names

- **If your XENTRY session ends mid-download,** the documents already finished are kept. The drawer shows **Download interrupted – N of M done**: log in again in the same tab (keep it open), then click **Resume** to continue where it stopped, or **Discard**.
- **Zips stop at 400 MB,** because a zip is built in memory before it's saved. A bulk batch that reaches the limit is offered for review with what it has; the rest stay pending for the next batch. A single-LI download lists what didn't fit, and **Fix** puts those back in the box.
- **Folder and file names are shortened** (topic folders to about 60 characters, attachment names to 60, keeping the extension) so that unzipped paths stay well under Windows' 260-character limit.

## Request pacing

- **Index and search replays** use the same page size as the Reader's own search (learned from your searches in the tab; shown under **⚙**), one page every 0.3 s.
- **Between documents** the exporter waits a random time within the range under **⚙** (2–5 seconds by default), also between auto-continued batches. The progress line counts the wait down; Pause and Cancel work during it.

## What's inside each zip

```
_progress_log_all_documents.csv   batches only: every topic, exported / pending (import this to resume)
_batch_NNN_manifest.csv           per doc: version, attachments, links, prior versions, status
_batch_NNN_errors.txt             only if something failed or was skipped
LIxx.xx-P-xxxxxx - <Title>/
    LIxx…_vN.pdf  LIxx…_vN.json
    Attachments and Links/        attachments + _attachments_and_links.csv (only if any)
    Revision History/             revision_history.csv/.json + LIxx…_v1.pdf … v(N-1).pdf
```

Under **⚙ → Data files to include** you can switch the `.json` / `.csv` data files on or off (**All**, **CSV only**, **JSON only**, **None**). PDFs, prior versions and attachments are always saved, and the progress log is always in batch zips.

## Where things are stored

Settings, bulk progress and recent downloads are kept in the extension's own storage (`chrome.storage.local`) in this browser, so clearing XENTRY's site data doesn't erase them. The batch zips' progress log is your backup.

## Troubleshooting

- **Something doesn't seem to work:** open the exporter, click **⚙**, then **Check setup**. It lists what it found on the page (session, search page size, header, ⋮ menu, topic toolbar, TIPS fonts, Chrome version) and what to do about anything marked ✗.
- **TIPS Exporter isn't in the ⋮ menu, or the row / toolbar buttons don't appear:** reload the TIPS tab, or use Alt+Shift+E.
- **Every request fails after a XENTRY update:** set the new Reader version in ⚙ (the `vX.Y.Z` at the top right of TIPS).
- **Chrome asks "Allow multiple downloads?":** click Allow for xentry.mercedes-benz.com.

## Checking a new version

After updating, reload the extension and the TIPS tab, then check:

1. **⋮ → TIPS Exporter** (and Alt+Shift+E) open the drawer.
2. **⚙ → Check setup** shows ✓ for Session, Drawer position, ⋮ menu and TIPS fonts.
3. Open a topic: the button next to **Print** saves `TIPS_<LI>.zip` for that topic.
4. In the results list, the row download icon saves one topic; ticking two rows and **Download 2** saves both.
5. After a search, **Use search** lists its topics.
6. In **Bulk export**, with batch size 2, prepare and approve a batch; the progress log updates.
7. Reload TIPS: settings, progress and recent downloads are still there.

## For developers

The extension needs no build step: load the repository folder with **Load unpacked**. The tests simulate the TIPS Reader in [jsdom](https://github.com/jsdom/jsdom):

```
npm install
npm test
```
