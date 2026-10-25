# LAC-CODEX-02: Codex protocol driver

- Parent: [local-agent-codex](INDEX.md)
- Change: local-agent-codex
- Task: LAC-CODEX-02
- Design: [local-agent-codex](../../design/local-agent-codex.md)
- Status: completed
- Depends on: LAC-CODEX-01
- Design sections: 4B, 6, 7

## Acceptance

Implement and verify the assigned design sections with deterministic offline tests. Authorization, persistence, idempotency and audit decisions belong to the responsible server layer. Record actual evidence and remaining gaps before completing this task.

## Evidence

Ten deterministic driver tests and nine host tests passed. Adapter and local-agent package type checks passed. Real installed CLI initialization, effective policy isolation, authentication status and model discovery passed without a model turn. Version pinning, one-shot bounded patch approvals, sandbox escape denial, structured answers and interruption were exercised. Ambient MCP entries are explicitly disabled because CLI table overrides merge; plugin, hook and app features are disabled and verified.
