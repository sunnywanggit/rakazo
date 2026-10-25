# LAC-CODEX-03: Persistence and worker integration

- Parent: [local-agent-codex](INDEX.md)
- Change: local-agent-codex
- Task: LAC-CODEX-03
- Design: [local-agent-codex](../../design/local-agent-codex.md)
- Status: completed
- Depends on: LAC-CODEX-02
- Design sections: 3, 4C, 6, 8

## Acceptance

Implement and verify the assigned design sections with deterministic offline tests. Authorization, persistence, idempotency and audit decisions belong to the responsible server layer. Record actual evidence and remaining gaps before completing this task.

## Evidence

Added tenant-scoped connections, immutable run snapshots, encrypted native requests/output/decisions, session generations, durable event cursors and worker fences. Native interactions use a dedicated authenticated response endpoint; ordinary chat answers cannot grant them. Stop, clear, archive and revocation confirm host cancellation, including cancellation before a worker starts. Optional origin configuration keeps the feature disabled by default.

Validation: all six relevant offline suites passed after the gate adjustment (450 tests). A separate runtime-role Postgres instance passed authenticated signup, connection pairing, two-turn native session reuse, encrypted storage, explicit allow/deny with observed file effects, duplicate decisions, generic-answer rejection, blocked-turn cancellation and revocation using a real HTTP host and a fake CLI process. API and worker TypeScript checks passed. Migrations only add tables, indexes, relations and RLS policies; existing tables remain compatible.
