# Case Inspector Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display case metadata, communication candidates and captured API data in TIPS Exporter.

**Architecture:** A pure shared core handles redaction, classification and bounded storage. A MAIN-world observer captures passive fetch/XHR responses. An isolated-world viewer owns the model and renders into the existing drawer.

**Tech Stack:** Manifest V3, plain JavaScript, Node/jsdom tests, Chromium.

**Spec:** docs/superpowers/specs/2026-11-16-case-inspector-design.md

## Global Constraints
Chrome 111; no new permissions; no active backend probing; memory-only; 256 KiB bodies, 100 records, 2 MiB record budget; all dynamic text safely rendered.

## Review Focus
- Concurrent navigation: record start-page context, not completion-page context.
- Streaming/oversized data: bounded clone reads and explicit omission/truncation.
- Credentials in nested JSON/URLs: sanitize before crossing the page bridge.
- Clear/pause while requests are pending: stale captures must not reappear.
- Unknown field names: raw data remains available; heuristics do not imply hidden/internal status.

### Task 1: Case Inspector
**Files:** Create case-inspector-core.js, case-inspector-probe.js, case-inspector.js, tests/case-inspector.test.js; modify manifest.json, content.js and README.md.

**Interfaces:** globalThis.TipsCaseCore exposes sanitize(value), body(value), cleanUrl(url), eligible(url, route), summarize(records), createStore(). The store exposes add(record), list(), clear(), dropped. globalThis.TipsCaseInspector exposes html(), bind(root, refresh), onChange(callback). Bridge uses tipsx-case-data and tipsx-case-command with bounded records and explicit status.

- [x] Write tests for pure core, passive transport, pending clear/pause, selected-context UI and text-only display. Run `node tests/case-inspector.test.js`; expected missing-feature failure.
- [x] Implement shared core, bounded capture and in-memory bridge. Re-run focused tests; expected PASS.
- [x] Integrate Cases section and viewer, bump extension to 1.22.0, document capture limitations and use. Test UI controls and synthetic data in Chromium.
- [x] Run `npm test`; expected no additional failures versus the inspected baseline. Run JS syntax checks and `git diff --check`.
- [x] Review changes; publish isolated branch and draft PR with the documented validation limits; leave main unchanged.

Pre-flight: probe and viewer share the core's sanitized record format; sanitize again at the isolated-world boundary. Viewer callbacks refresh only when its section is visible.

## Validation ledger

- Focused tests: 16 passed, including the real drawer loaded in jsdom with manifest scripts.
- Review: independent reviewer identified relative signed URL redaction, unbounded pending observer reads, and the JSON object byte limit. All three reproduced RED and fixed GREEN.
- Ruling: bounded observer streams (16 concurrent, 10-second deadline) may omit unusually slow/busy response bodies; this is shown explicitly and protects the host page.
- Ruling: no real Chromium UI run was possible because the environment prohibits its process-singleton socket. Simulated DOM integration passed; visual and live authenticated XENTRY checks remain outstanding.
- Baseline full suite: 387 passed, 3 failed before this feature. Existing failures: missing tracked attachment repair; failed attachment close retry; Stop persistence before network completion. These are outside the Inspector changes and will be listed in the draft PR.
- No private case snapshots or live customer data are included in this branch.

- Final full suite: 402 checks passed, the same 3 baseline failures; one additional focused timeout check brought the focused run to 16 passed. JavaScript parsing and manifest file checks passed. `git diff --check` passed.
