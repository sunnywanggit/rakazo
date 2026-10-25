# LAC-CODEX-04: Shared client controls

- Parent: [local-agent-codex](INDEX.md)
- Change: local-agent-codex
- Task: LAC-CODEX-04
- Design: [local-agent-codex](../../design/local-agent-codex.md)
- Status: completed
- Depends on: LAC-CODEX-03
- Design sections: 2, 9

## Acceptance

Implement and verify the assigned design sections with deterministic offline tests. Authorization, persistence, idempotency and audit decisions belong to the responsible server layer. Record actual evidence and remaining gaps before completing this task.

## Page SEO Contract

Applies to authenticated bot settings and private thread controls on web/Electron/mobile. No new public route, indexing, metadata intent, search keyword or sitemap entry is introduced. SEO keyword input is absent and not needed for private application controls; marketing-page content requirements are inapplicable. Reuse current settings and ask-card surfaces, reveal pairing fields only on demand, and keep labels concise.

## Evidence

Web and Electron share the existing advanced bot-settings surface. Mobile uses the same settings controller, native menus and native action buttons. Pairing fields are disclosed on demand and the token field clears when submitted. Both clients route local card decisions through the dedicated RPC, render structured questions and stop accepting expired requests. Native bots hide incompatible runtime settings and computer controls; uploaded files are unavailable because the selected host project owns the files.

Validation: seven focused client/core suites passed (130 tests), including explicit question submission, expired approvals, read-only target defaults, explicit save and token clearing. Web, mobile and shared chat UI TypeScript checks passed. A Web E2E case with a screenshot capture was added for CI; Electron windows and native mobile UI were not launched locally.

Necessary visible copy includes “Execution”, “Connect local agent”, “Save execution”, “Project access”, “Read only”, “Read and write”, “Revoke connection”, “Local project: …” and contextual connection errors. These identify the execution target, distinguish native permissions and expose controls only in advanced settings or an active request. Pairing details appear only after Connect is opened.
