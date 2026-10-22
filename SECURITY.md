# Security and data handling

This policy covers `@yyyzl/dsh-image-feedback`. It describes implementation boundaries, not an independent security certification. Trust the package source before installing: it contains both a Harness Host plugin and a browser Client plugin.

## Where data goes

| Data | Storage or destination |
|---|---|
| Imported original and generated reference images | Harness attachment storage, associated with the bound session |
| Asset references, draft text/geometry, save versions, submission receipts | Host storage domain `dsh_image_feedback` |
| Recovery draft and annotation text | Browser-origin local storage, under `dsh.image-feedback.recovery.v1.` plus the session ID |
| Short-lived UI session authorization | In-memory Client/Host state; not intended as a persisted credential |
| Explicitly submitted feedback | A separately queued Harness prompt containing actual image content and feedback |

Submission follows the session's Harness/model-provider configuration and its data-handling policies. The plugin has no separate telemetry or external image-upload endpoint; this is **not** a promise that model requests stay on your device.

Local recovery can contain sensitive comments. Disabling or uninstalling the bundle does not automatically erase Host attachments, drafts, or browser site data. Use supported Harness retention/deletion controls and browser site-data controls as appropriate, after preserving any work you need.

## Access boundaries

- UI operations require an authenticated owner page and a short-lived authorization scoped to a session. Image reads also check owner authentication and session ownership.
- The Agent tool is bound to its executing session. Supplying another `sessionId` must not grant access to that session's assets or drafts.
- Path imports read files on the **Host machine** through the requesting Agent's filesystem service. They are not browser uploads. Effective read permissions come from Harness and may be broader than a workspace; do not assume a workspace sandbox exists. The plugin does not bypass a rejected read with another filesystem implementation.
- The plugin retains normalized attachment references rather than putting image Base64 into draft records. It validates asset identity and coordinates before saving or sending.
- Sending is explicit and independent of the chat composer. Inserting text is a separate action and does not send images.
- A queued/accepted response is not proof of a model response or successful image editing. Retry uncertain submissions with the same request ID; changing the ID can create a second request.

The legacy and public bundles share identifiers and storage. Never activate both together. Follow [migration instructions](<README.en.md>) rather than editing profile manifests or storage files.

## Report a suspected issue

1. Record package version, Harness version, affected operation, and expected versus observed behavior.
2. Prefer a minimal reproduction using the repository's synthetic fixture or an image you can safely share.
3. Check the repository's [Security tab](<https://github.com/yyyzl/dsh-image-feedback/security>) for an available private reporting option. Its availability is not guaranteed by this document.
4. If no private channel is offered, open a minimal [issue](<https://github.com/yyyzl/dsh-image-feedback/issues>) asking the maintainer to establish one. Do not include exploit details or sensitive data in that public request.

**Do not post** authorization values, credentials, real session/attachment IDs, personal file paths, full profile exports, or private images. Crop or redact diagnostic screenshots. Do not test another person's session, bypass Host authentication, or send real model prompts without permission.

There is no promised response time or external audit claim. General bugs and feature requests belong in public issues; reports suggesting unauthorized access or cross-session disclosure should use a private channel whenever one is available.
