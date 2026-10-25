# LAC-CODEX-01: Host protocol and service

- Parent: [local-agent-codex](INDEX.md)
- Change: local-agent-codex
- Task: LAC-CODEX-01
- Design: [local-agent-codex](../../design/local-agent-codex.md)
- Status: completed
- Depends on: none
- Design sections: 4A, 5, 7, 8

## Acceptance

Implement and verify the assigned design sections with deterministic offline tests. Authorization, persistence, idempotency and audit decisions belong to the responsible server layer. Record actual evidence and remaining gaps before completing this task.

## Evidence

Nine offline HTTP/host tests passed. Contracts and adapter-kit type checks passed. Scoped token authentication, Origin/Host rejection, project authorization, input idempotency, lease fences, event cursors, one-shot approval responses, private session recovery, restart uncertainty and bounded retention were exercised. Biome checks passed.
