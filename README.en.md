# Image Feedback

[简体中文](<README.md>) · [Testing](<docs/TESTING.md>) · [Security and data handling](<SECURITY.md>) · [Marketplace submission](<docs/MARKETPLACE.md>)

A native DeepSeek Harness sidebar: draw a region, type feedback immediately, drag regions to rearrange image blocks, then send the original image, numbered reference, and feedback to the current session.

- Package identifier: `@yyyzl/dsh-image-feedback`, version `0.1.0`.
- Distribution: [GitHub Releases](<https://github.com/yyyzl/dsh-image-feedback/releases>), not npm. `private: true` intentionally prevents accidental npm publication. The package identifier does not establish npm availability or ownership of that registry scope.
- Compatibility is declared in the [manifest](<package.json>). Main interactions were checked on the original local implementation with Harness `0.2.1-rc.2`; live installation and migration of the public namespace have not yet been verified. See [testing status](<docs/TESTING.md>).
- Market status: [listing request #53](<https://github.com/polang233/dsh-plugin-index/issues/53>) has been submitted to the open plugin index. Review is pending; this is not an accepted listing.
- This is a third-party plugin, not an official Harness component. It needs no separate server and does not modify the host ASAR.

> Already using `@local/dsh-image-feedback`? Follow the migration steps below. **Never enable both bundles together**: they share storage, commands, and UI identifiers.

## Install

Before installing, check the prebuilt archive and [SHA256SUMS.txt](<https://github.com/yyyzl/dsh-image-feedback/releases/download/v0.1.0/SHA256SUMS.txt>) on the [v0.1.0 release](<https://github.com/yyyzl/dsh-image-feedback/releases/tag/v0.1.0>). Use the fixed-version URL below.

Ask the Agent in your Harness session to use the official `plugin_manager` tool. List bundles first:

```json
{"action":"list_bundles"}
```

After confirming that the legacy bundle is not active, install:

```json
{"action":"install_bundle","target":"https://github.com/yyyzl/dsh-image-feedback/releases/download/v0.1.0/yyyzl-dsh-image-feedback-0.1.0.tgz"}
```

Installation affects every session in the current profile. Follow the manager's compatibility checks, warnings, and refresh/restart instructions. Do not edit profile manifests, replace host files, or bypass version restrictions.

To disable, list bundles again to confirm the exact name, then use:

```json
{"action":"set_bundle","target":"@yyyzl/dsh-image-feedback","enabled":false}
```

Use `enabled: true` to re-enable, or `remove_bundle` to uninstall. Disabling does not itself erase image assets, saved drafts, or browser recovery data.

### Migrate from the local bundle

1. Finish the active text edit and wait for saving to succeed. Export feedback JSON for important work, then close the old sidebar.
2. Confirm the legacy package with `list_bundles`, then disable `@local/dsh-image-feedback` through `set_bundle`.
3. Install the public bundle through the official manager. Follow any restart/refresh instructions and reopen Image Feedback.
4. Check assets and drafts in the original session. If they differ, stop editing, retain your export, and report the problem. Do not manually move or delete host storage.

The public package retains the `dsh_image_feedback` storage domain, draft schema, recovery key, and legacy sidebar identifiers to reduce compatibility changes. This is not a verified migration guarantee. Publishing this repository or a release does not automatically update an existing local installation.

## Use

1. Open **Image Feedback** from the chat input toolbar.
2. Paste, drop, or choose an image, or open **Session images**. Path/Base64 imports are in the more menu; pasting inside a comment remains normal text input.
3. Keep the default **Select** tool and drag a rectangle. Its comment editor focuses on release—there is no separate “add comment” step.
4. Drag the region to rearrange it. A block is cut only when a real move occurs; an unmoved region remains an annotation. Drag existing blocks directly to move them again.
5. Choose **Send feedback** to independently queue the real original, red-numbered reference, and structured feedback. It does not send or clear the chat input's existing draft. **Insert text** inserts feedback text only, without images or automatic submission.

Moves can be sent without written comments. “Queued” means the Host accepted the request, not that a model has produced an edited image.

### Editing controls

- Annotation outlines are red, with white numbers on red markers; reference exports use the same palette.
- Click a marker or note row to edit. Blur completes a text edit; a newly created empty note is cancelled. Esc cancels the current text transaction; Ctrl/Cmd+Enter finishes it.
- A text-edit transaction or a drag creates one undo step. With the canvas focused, use Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z; text fields keep normal text shortcuts.
- **Point comments:** click to edit; drag a marker to reposition it without moving pixels. Free points stay within the canvas; block-bound points retain their binding and stay inside that block.
- Shift-drag starts a new region inside an existing selection. Arrow keys nudge a selected block; Shift makes larger nudges.
- Use the pan tool, Space-drag, or middle-button drag after zooming. Blocks can be reset; removing a block with comments requires confirmation.

## Saving and limits

- Assets use Harness attachment storage. Drafts save per session and image, with a browser-local recovery checkpoint.
- Version checks prevent silent multi-window overwrites. On a conflict or save failure, export important feedback before explicitly retrying or reloading.
- Retries of the same submission reuse its request ID. Do not create a new ID merely because acceptance is uncertain. Undo history is runtime-only, not guaranteed across restarts.
- Coordinates use Host-normalized original-image pixels. Originals are unchanged; blocks translate but do not scale. Source regions cannot overlap, destinations may overlap, and movement stays within the fixed canvas.
- Path imports read the **Host machine**, not the browser machine. Access follows the current Host filesystem service; the plugin does not use a fallback reader after a denial.
- No OCR, semantic cutouts, background repair, rotation, video, or multi-image batch processing. See [data handling](<SECURITY.md>) for sending and retention boundaries.

## Develop and verify

Develop from a Git clone, not the installed package. Use Node.js 22+ and pnpm `11.28.5`, pinned by `packageManager` in the repository [manifest](<package.json>). From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run build
pnpm run check
```

The recorded baseline is **120 deterministic tests**, not 120 browser E2E tests. Public-namespace, archive-install, migration, and live-UI acceptance need separate evidence; a successful build does not prove them. See [testing](<docs/TESTING.md>) and [contributing](<CONTRIBUTING.md>).

Source edits do not automatically update installed Client artifacts. Build first, update through the supported installation flow, and refresh the existing Harness page. Do not start a replacement server to validate the plugin.

## License

Project code and the original icon use the [MIT license](<LICENSE>). EditHere's interaction ideas were studied, but this implementation was independently written and does not include its code, icons, or design assets or claim its endorsement. This statement is not a legal certification of all third-party rights. Zod retains its own MIT license; React is supplied by the Host rather than bundled again.
