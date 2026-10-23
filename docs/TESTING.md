# Testing and verification

This guide distinguishes deterministic tests, original-build observations, and release work still requiring verification. It is not a browser E2E or migration certification.

## v0.2.0 validation

After synchronizing the optimized implementation into the public package, all **145 deterministic tests** passed locally on Node.js `24.21.0`. Build and package validation passed; entry 4,400 bytes / lazy editor 135,921 bytes. These are not browser E2E tests. This publishing procedure does not repeat live UI, public-profile installation, migration or model submissions. Prior UI evidence below applies to the original baseline only.

New coverage:

- [Canvas zoom](<../tests/canvas-zoom.test.mjs>): wheel/pinch normalization, cursor anchors, centered-to-overflow transitions, bounds and coalescing; listener wiring is a source contract.
- [Review ledger](<../tests/review-ledger.test.mjs>): shared labels, move-only items, deletion/undo, serialization and local-note separation.
- [Refinements](<../tests/refinement-regressions.test.mjs>): custom-ID move order and burst anchors; focus wiring is a source contract.
- [Design contracts](<../tests/design-contract.test.mjs>): responsive rules, local focus/scroll behavior, keyboard locks and localization; not rendered visual QA.
- [Host](<../tests/host.test.mjs>): Request-based owner/session authorization, 24 autosaves without command events, body-size enforcement, cancellation and submission deduplication.

Upgrade requires a Harness restart plus page refresh so the updated Host endpoint and Client load together. Storage/schema/recovery identifiers remain stable; that alone is not migration proof.

## Recorded v0.1.0 baseline

| Check | Observed result | What it does not prove |
|---|---|---|
| Node test suite on the original source baseline | 120 tests passed, with no failures | 120 browser E2E scenarios or complete security coverage |
| Package validation on that baseline | Manifest/runtime files, locale keys, module syntax, and selected Client contracts passed | Installation from the public release URL |
| Generated artifact comparison | Both runtime files matched a read-only reconstruction from their sources and the entry's content digest | A signed build or a deployed public namespace |
| Original local UI on Harness `0.2.1-rc.2` | Human checks confirmed region autofocus, red markers/readable send control, direct region movement, and point-marker dragging | Every theme, viewport width, zoom level, or browser |
| Original Host transport with synthetic images | Independent image-bearing submission accepted; an identical retry was deduplicated | Actual UI canvas export or completed model image editing |
| Public namespaced source on Node.js `24.21.0` | 120 tests, rebuild and package checks passed after renaming module owners; entry 4,091 bytes / lazy editor 115,691 bytes | Live public installation or migration |
| [GitHub CI for the v0.1.0 source](<https://github.com/yyyzl/dsh-image-feedback/actions/runs/39844975332>) | Node.js 22 and 24 jobs passed tests, rebuild parity, package validation, packing and archive verification | Browser rendering or a live profile installation |
| Public v0.1.0 asset | Anonymous download matched SHA-256 `cb59eb16fbdce8a3cd7cff2ce51a129c5660e4f07ba90542b6d34027187840d2`; all 35 packed files passed closure, identity, byte-parity and documentation-link checks | Installation or model-provider behavior |
| Public `@yyyzl/dsh-image-feedback` installation and legacy migration | Not yet live-verified in this documentation snapshot | Preserved identifiers alone do not establish a successful migration |

The recorded Node run used Node.js `24.21.0`; the release-preparation environment also has pnpm `11.28.5`, now pinned in the [manifest](<../package.json>). The linked CI run separately exercised Node.js 22 and 24; it does not establish coverage of every runtime/package-manager combination. Private session records, real identifiers, user quotes, and design concepts are deliberately not included as public evidence.

Publishing source or packing an archive does not update the original installed local bundle. Record any later public-release verification separately, with its exact version and limits.

## Run the deterministic checks

From the repository root, with Node.js and pnpm available:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run build
pnpm run check
```

Use the actual test output for the current count. These checks do not require account access or integration sends. The build updates [the Client entry](<../client.js>) and [the lazy editor](<../client.editor.js>); review both generated artifacts with their source changes.

| Test group | Scope |
|---|---|
| [Core](<../tests/editor-core.test.mjs>) | Immutable identity, normalized coordinates, source/destination rules, undo, serialization, feedback |
| [Host](<../tests/host.test.mjs>) | Mocked Host services, session ownership, normalized imports, persistence conflicts, authorization, idempotent sends |
| [Session state](<../tests/session-state.test.mjs>) | Loading/saving races, stale results, recovery, version conflicts |
| [Intent](<../tests/editor-intent.test.mjs>) | Selection, region promotion, overlap regression, block and point moves |
| [Lifecycle](<../tests/editor-lifecycle.test.mjs>) | Text transactions, undo grouping, image switching, cancellation, disposal |
| [Client contracts](<../tests/client-contract.test.mjs>) | Selected source-level UI, color, and interaction contracts—not rendered screenshots |

The [original fixture](<../tests/fixtures/layout-fixture.png>) and [transport reference](<../tests/fixtures/layout-reference.png>) are synthetic test images. The reference was created for transport testing; it is not proof of the current UI export path. Regression tests use synthetic identities; their rectangle coordinates describe reproducible geometry, not a real user session.

## Check a release archive

From a Git checkout, pack and inspect the actual archive (without installing it into a live profile):

```sh
pnpm pack --pack-destination artifacts
pnpm verify:pack
```

The verifier checks required runtime files, module/package identity, file-byte parity, and private-artifact/link exclusion. pnpm deliberately omits the repository lockfile and strips the `packageManager` field from its packed manifest; development remains rooted in the Git checkout. All runtime manifest fields must still match.

A maintainer should complete these checks before claiming an installable release:

1. Build and rerun the deterministic checks after the public package/module-owner changes.
2. Inspect the archive file list: Host entry/adapter/core, both Client runtime files, bundle patch, locales, icon, manifest, and license must be present. Declared runtime dependencies must remain in the manifest.
3. Exclude private verification records, design artifacts, account-specific paths, credentials, profile data, and dependency working directories. Check that documentation links resolve within the distributed material or explicitly point to the public repository.
4. Check that the release asset name and URL match [the install instructions](<../README.en.md>). An archive on disk does not prove the GitHub asset exists.
5. With explicit authorization, install through the official Harness manager in an appropriate test environment. Follow any restart/refresh instruction and inspect actual Host/Client availability.

`private: true` intentionally blocks npm publishing, not archive packing. Do not authenticate to npm or publish there as part of this procedure. Do not silently enable the legacy and public bundles together.

## Manually check the actual Harness UI

Use a dedicated session and synthetic images; do not clear a real draft to make testing easier. Rebuild/reinstall through the supported flow and refresh the existing Harness page. A standalone demo server is not equivalent to the installed plugin.

- Open the native sidebar. Test paste, drop, file selection, and session-image selection.
- Draw a region and type immediately. Confirm red marks, readable controls, direct region/block dragging, and point-marker dragging without moving pixels.
- Confirm one drag/text transaction produces one undo step; cancel an unfinished edit and check that earlier work remains.
- Save, close, reopen, and switch images. Check restore behavior and that a stale save reports a conflict instead of overwriting another window's work.
- Check fixed-canvas bounds, source-overlap rejection, destination overlap, and block-bound point limits.
- Check light/dark themes, narrow sidebars, zoom/pan, keyboard focus, and ordinary text editing. Static CSS assertions do not replace these checks.
- In a disposable composer draft, test text insertion with a selected range and reference chips; existing content must remain intact. Test that a claimed slash-command draft is not treated as an ordinary message.

Sending invokes the normal model/provider path. **Obtain explicit permission before a test send.** Then check the actual image-bearing request, reference rendering, composer preservation, same-ID retry, and any resulting model response separately. Acceptance alone is not completion.

For a migration rehearsal, save/export work and follow [the legacy migration steps](<../README.en.md>). Verify assets and drafts after activation; do not manually copy storage or treat matching identifiers as migration evidence.

## Record results without exposing user data

Include the package version/commit, Harness version, runtime version, operation, observed outcome, and remaining gaps. Use synthetic identifiers and redact screenshots. Keep private logs outside the public tree; do not publish local design renders as product screenshots. For a possible security issue, follow [the reporting policy](<../SECURITY.md>).
