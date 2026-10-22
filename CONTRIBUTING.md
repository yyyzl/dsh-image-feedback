# Contributing

Use issues for reproducible bugs and focused proposals. For a possible security issue, follow [the reporting policy](<SECURITY.md>) instead of posting sensitive details publicly.

## Set up and check a change

Use Node.js 22+ and pnpm `11.28.5`, as pinned in the [manifest](<package.json>). From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run build
pnpm run check
```

The repository [lockfile](<https://github.com/yyyzl/dsh-image-feedback/blob/main/pnpm-lock.yaml>) pins dependencies; pnpm excludes it from release archives. The project has no installation lifecycle script. Do not add one or an unnecessary dependency to solve a documentation or UI-only problem.

Run the build when changing Client sources, and include both generated artifacts, [the entry](<client.js>) and [the lazy editor](<client.editor.js>), in the review. Build success is not installation or browser validation; record checks using [the testing guide](<docs/TESTING.md>).

## Find the right source

| Area | Source |
|---|---|
| Package loading and runtime compatibility | [Manifest](<package.json>), [bundle patch](<cordis.patch.yml>), [Host entry](<index.js>) |
| Ownership, attachments, persistence, idempotent sends | [Host adapter](<host.js>) |
| Immutable geometry, draft schema, undo, feedback | [Editor core](<editor-core.js>) |
| Native sidebar and lazy loading | [Client entry](<src/client-entry.js>) |
| Pointer/keyboard interaction and presentation | [View](<src/editor-view.js>), [styles](<src/editor.css>) |
| Text transactions, movement, asynchronous recovery | [Intent rules](<src/editor-intent.js>), [session state](<src/session-state.js>) |
| Host bridge and reference-image export | [Browser adapter](<src/editor.js>) |
| Localized UI text | [Messages](<src/messages.json>), [English metadata](<locale/en.json>), [Chinese metadata](<locale/zh.json>) |

## Preserve compatibility and user work

The public package name is `@yyyzl/dsh-image-feedback`. Some internal identifiers intentionally retain their earlier names:

- Host domain `dsh_image_feedback`, version `1`.
- Draft schema `harness-image-feedback-1`.
- Recovery prefix `dsh.image-feedback.recovery.v1.`.
- Sidebar ID `@local/dsh-image-feedback` and kind `local-image-feedback`.
- Command `image-feedback`, tool `image_feedback`, and the existing image/authorization routes.

Do not “clean up” these identifiers with a global rename. Changes need an explicit compatibility plan and migration tests. Public and legacy bundles must not run together.

Keep source images immutable, coordinates tied to normalized asset pixels, and state scoped to the current session. Preserve version-checked saving, stable retry IDs, one-gesture undo, and composer preservation. Use documented Host/Client APIs; do not copy private package internals or patch the Harness installation.

## Keep contributions public-safe

- Use synthetic images, session IDs, and feedback in tests. Numeric regression geometry can be synthetic reproduction data; do not include the original user's conversation or assets.
- Do not commit private verification records, account paths, authorization values, actual session/attachment IDs, or screenshots containing personal material.
- Keep local design concepts separate from release screenshots; never present a concept render as running-product evidence.
- Submit only code and assets you may license under this project's [MIT license](<LICENSE>). Do not copy EditHere code or assets; studying an interaction does not grant permission to redistribute an implementation.
- Explain behavior changes, relevant tests, and any unverified UI or compatibility case in the pull request. Update [Chinese](<README.md>) and [English](<README.en.md>) usage together when needed.

## Release boundaries

Releases are GitHub-hosted archives. `private: true` is an intentional npm-publish guard, not a reason to publish credentials or change registry settings. It does not prevent packing an archive. A maintainer must verify its runtime contents and install path before claiming release readiness; do not publish, reinstall, or send integration prompts as an incidental test.
