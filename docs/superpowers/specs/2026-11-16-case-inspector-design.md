# Case Inspector

Approved in chat: add the full Case Inspector to TIPS Exporter, covering case metadata, ratings, communication and raw API requests/responses.

## Approaches
The user chose a structured Inspector over a raw-response-only viewer. Reuse the existing drawer with a Cases section. Keep the observer separate from the existing page-size probe and preserve export behavior.

## Behavior and limits
- Observe same-origin TIPS API fetch/XHR traffic on case pages, plus case endpoints elsewhere; never issue extra API requests or modify responses.
- Overview lists returned metadata and rating candidates with source paths. Communication identifies candidate fields by name, without claiming they are hidden/internal or interpreting an unknown rating scale.
- Raw requests show method, redacted URL, status, timing, request and response JSON; search, copy and JSON export operate on the selected case context.
- Show explicit unavailable, omitted and truncated states. JSON only, maximum 256 KiB per body, 100 records and 2 MiB serialized records per world (page buffer and viewer mirror). At most 16 observer body reads, with a 10-second read deadline. Individual strings are capped at 16,000 characters and traversal at 5,000 values / 20 levels with truncation markers. Sensitive named fields and URL parameters are redacted; no headers or cookies are collected. Arbitrary free text may still contain personal data.
- Capture begins at document_start, buffers early responses, and survives SPA navigation in tab memory. Requests retain their start-page context. Pause and Clear discard pending captures; reload clears all records. No persistent storage or upload.
- User may select a captured case context; context means where the request started, not proof every returned item belongs to that case. Backend-only data the server does not return cannot be exposed.
- No additional extension permissions. Chrome 111 floor retained.

## Verification
Synthetic data only in committed fixtures. Test fetch/XHR passthrough, early buffering, redaction, request forms, caps, abort/errors, navigation, clear/pause, hostile text rendering, filtering and exports. Run full existing suite and a local Chromium UI check. Live authenticated XENTRY verification remains a user-side check.
