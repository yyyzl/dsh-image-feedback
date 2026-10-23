# Changelog

## 0.2.0 — 2026-10-23

### Added

- Unified, contiguous review labels across notes, move-only blocks, the canvas, exported reference and feedback text, while retaining persisted IDs and legacy annotation numbers.
- Cursor-anchored wheel zoom, trackpad pinch and Safari gesture handlers with bounded, stable burst anchors.
- Responsive review desk with block crops, move metadata, click-to-center navigation, improved empty/drop states and short-panel focus handling.
- Owner-authenticated, session-authorized background operations endpoint for imports and autosaves without new chat command records.

### Fixed

- Preserve move-only block order when adding its first whole-block comment, including custom IDs.
- Keep editor focus when first-character input relocates a review item.
- Improve selected-tool contrast, keyboard submission locking, path-dialog Escape and gesture cleanup.
- Hide only legacy internal command rows through the exact command-view slot; preserve durable audit records and actual tool/submission messages.

### Upgrade notes

Save/export important work, update through the official manager, restart Harness and refresh the page. Host and Client must update together; the new Client checks the Host's unified-label capability before sending. Storage domain, draft schema, source identities and recovery keys remain unchanged. Do not enable legacy local and public bundles simultaneously. No live public-profile upgrade or fresh model send was performed as part of publishing.

Validation: 145 deterministic tests passed locally; package/build checks are separate from rendered UI and migration verification.

## 0.1.0 — 2026-10-23

Initial public GitHub release: native sidebar image imports, direct region and point annotations, block translation, undo/redo, durable drafts and independent image-bearing feedback submission. Baseline: 120 deterministic tests. Accepted by the open plugin market through issue #53.
