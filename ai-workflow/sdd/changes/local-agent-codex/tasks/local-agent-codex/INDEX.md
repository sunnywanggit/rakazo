# local-agent-codex

- Goal: optional local Codex runtime with conversations, approvals, cancellation and recovery.
- Design: [local-agent-codex](../../design/local-agent-codex.md)
- Status: in progress; implementation and acceptance authorized by the user.
- Priority: all tasks required for delivery.

| Task | Scope | Status | Dependency |
| --- | --- | --- | --- |
| LAC-CODEX-01 | [Host protocol and service](LAC-CODEX-01-host-protocol.md) | completed | none |
| LAC-CODEX-02 | [Codex protocol driver](LAC-CODEX-02-codex-driver.md) | pending | LAC-CODEX-01 |
| LAC-CODEX-03 | [Persistence and worker integration](LAC-CODEX-03-server-integration.md) | pending | LAC-CODEX-02 |
| LAC-CODEX-04 | [Shared client controls](LAC-CODEX-04-client-controls.md) | pending | LAC-CODEX-03 |
| LAC-CODEX-05 | [Recovery acceptance and operations](LAC-CODEX-05-acceptance-recovery.md) | pending | LAC-CODEX-04 |

Execution topology: 01 -> 02 -> 03 -> 04 -> 05. Sequential execution as requested; no parallel agent queue. No cross-Change dependency.

## Definition of done

- All task tests pass and default runtime continues to work.
- Host authorization, secrets, sandbox, approvals and uncertain execution fail safely.
- Sessions and events recover without replaying side effects.
- Web, Electron and mobile share server authorization and interaction contracts.
- Offline acceptance, type checks and relevant client checks are recorded; live model tests are separate.
- One local commit per completed feature; no push or deployment.

## Boundaries and blockers

First release uses native coding tools only. Docker tool forwarding, multiple accounts and importing existing Codex chats are excluded. Dependencies are being prepared; no external blocker identified.
