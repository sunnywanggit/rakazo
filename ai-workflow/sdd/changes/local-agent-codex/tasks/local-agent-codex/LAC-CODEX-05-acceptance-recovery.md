# LAC-CODEX-05: Recovery acceptance and operations

- Parent: [local-agent-codex](INDEX.md)
- Change: local-agent-codex
- Task: LAC-CODEX-05
- Design: [local-agent-codex](../../design/local-agent-codex.md)
- Status: completed
- Depends on: LAC-CODEX-04
- Design sections: 10, 11, 12

## Acceptance

Implement and verify the assigned design sections with deterministic offline tests. Authorization, persistence, idempotency and audit decisions belong to the responsible server layer. Record actual evidence and remaining gaps before completing this task.

## Evidence

Implemented bounded transport recovery, receipt-first reattachment, durable cursor consumption, graceful worker handoff, missing-receipt refusal and native process-group cleanup after abrupt host death. Existing notification preferences now cover native completion and input requests. Added a private macOS LaunchAgent generator and operations guide covering setup, pairing, cancellation, credential rotation, rollback and bounded journal capacity.

## Acceptance evidence

- The sixteen related offline suites passed 622 tests; final host/driver additions subsequently passed in the focused 27-test host/driver/runtime suite (624 distinct related offline tests in total).
- The authenticated API/worker integration passed against a disposable Postgres runtime role with content encryption enabled: two native turns reuse a session; ordinary answers cannot grant native requests; allow/deny have observable file effects; duplicate decisions are idempotent; structured answers must be complete; worker restart and heartbeat transport loss reattach without repeating input; Stop and revoke are confirmed; all five new models remain invisible to another tenant. Notification assertions use an offline provider.
- Existing row-security and content-encryption Postgres suites passed thirteen tests each in separate disposable databases. These suites require separate databases: key-rotation fixtures intentionally change stored master-key versions, and the RLS fixture also requires Graphile migrations. No application database was used.
- TypeScript checks passed for contracts, adapter-kit, adapters, database, API, worker, shared chat UI, web, mobile, local-agent app/scripts and testkit across the implementation checkpoints.
- The installed reviewed Codex CLI passed initialize, authentication and model-catalog inspection without starting an inference turn.
- The real macOS sandbox canary passed all seven observable checks: project read/write, denied outside reads/writes, denied environment-file read, denied read-only write, unchanged outside fixture. It creates and removes temporary files only.
- LaunchAgent generation is covered by an offline test and plist syntax validation. No daemon was installed or loaded by this task.
- Web screenshot coverage was added for CI. CI screenshots, Electron windows and native mobile UI have not been executed in this local task; the repository explicitly avoids routine Electron E2E on a maintainer's Mac. Real-model quality/cost testing remains opt-in and was not performed.

## Delivery and limits

See [operations](../../../../../../docs/local-agent.md). The feature is optional and disabled until an operator grants exact helper origins after all workers are updated. It supports local project text tasks; unsupported tools are excluded. Journal capacity is bounded and intentionally does not erase idempotency receipts automatically; the guide describes draining and rotating a batch. No push, product deployment, live data migration or real-account pairing was performed.

## Retrospective

Most time went into verifying the native permission profile, process lifetime, recovery races and isolated database fixtures. The fake CLI, reusable host/runtime tests, real sandbox canary and startup generator now make subsequent changes testable without model usage or repeated manual setup. Separate databases for encryption-rotation and RLS suites avoid fixture interference.
