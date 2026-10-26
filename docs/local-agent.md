# Local Codex execution

Rakazo can route a selected bot to a separate host helper running `codex app-server`. Ordinary bots keep their existing runtime and computer. The helper accepts project IDs and scoped run requests, never arbitrary commands, paths or environment values from clients. The first release supports native project tools, text, questions and bounded file approvals. Docker/browser tools, connectors, voice turns, uploaded attachments and importing existing Codex chats are unavailable for this execution source.

Detailed component and sequence diagrams: [本机 Codex 架构图](local-agent-architecture.md).

## Enable after updating every worker

Apply the additive database migration and update **all** API and worker processes while `LOCAL_AGENT_ALLOWED_ORIGINS` is unset. Only then set this generic optional variable to the helper's exact origin in both services, for example `http://127.0.0.1:8789`. Leave it unset to keep local-agent settings unavailable. Existing bots require no new service or vendor account.

Do not enable targets during a rolling deployment with old workers. Before a rollback, revoke local connections, confirm all native runs ended, remove targets, then roll back. Do not drop the additive tables or erase host journals as a rollback shortcut.

## Prepare the Mac

Use the reviewed Codex CLI family `0.163.x`, signed in locally with `codex login`. Unknown CLI versions fail closed. The helper inherits the CLI user's authentication locally; no Codex auth directory or account token goes to Docker, the browser or the phone. Node 24 and installed workspace dependencies are required. Windows is not supported by this driver; macOS has a real sandbox canary.

Open the bot's **Advanced → Execution → Connect local agent** settings and copy its pairing IDs. In a private folder outside every project, create `config.json` (directory mode `0700`, file mode `0600`). Replace the following fake placeholders locally:

```json
{
  "root": "/absolute/private/local-agent/state",
  "token": "REPLACE_WITH_64_RANDOM_HEX_CHARACTERS",
  "hostname": "127.0.0.1",
  "port": 8789,
  "allowedHosts": ["127.0.0.1", "localhost"],
  "engine": {"kind": "codex", "executable": "/absolute/path/to/codex"},
  "projects": [{"id": "project", "label": "Project", "root": "/absolute/path/to/project", "access": "read"}],
  "bindings": [{"spaceId": "PAIRING_SPACE", "userId": "PAIRING_USER", "botId": "PAIRING_BOT", "projects": ["project"]}]
}
```

Generate the token locally with `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'` and place it directly in that private file. Never put the completed configuration, token, generated plist or journals in Git. Keep the state folder outside the allowed project; use canonical absolute project roots. Each binding grants only the listed project IDs to that account and bot. Start with read-only access; change both the private allowlist and the bot selection before permitting writes.

From the repository root, run:

```sh
pnpm --filter @rakazo/local-agent start --config /absolute/private/local-agent/config.json
```

Keep the helper on loopback when the API runs on the Mac. A containerized API must use an origin it can actually reach: configure the private host gateway/listener and matching `allowedHosts`, then add that exact origin to the API and worker allowlist. Browser and phone clients never connect to the helper directly. If a listener needs a non-loopback interface, restrict its network exposure with the host firewall or a private tunnel; authentication remains mandatory and HTTP Origin requests are rejected. Do not forward this port onto the public Internet.

In the bot settings enter the reachable endpoint and the private pairing token, connect, select a project/model, then **Save execution**. Rakazo stores the pairing token through its SecretStore and does not return it. Model choices come from the local CLI, independently of Rakazo model connections. Mobile offers the same selections and decisions through the Rakazo backend; installing, starting and authorizing the helper takes place on the Mac.

## Optional login startup

The generator creates a private LaunchAgent file and never loads it automatically:

```sh
pnpm --filter @rakazo/local-agent exec tsx scripts/launch-agent.ts /absolute/private/local-agent/config.json
plutil -lint "$HOME/Library/LaunchAgents/com.rakazo.local-agent.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.rakazo.local-agent.plist"
```

It uses absolute Node/tsx/source paths and argument arrays, with no shell and no token in the plist. Keep that checkout and runtime installed; regenerate the plist explicitly after moving them. Stop it with `launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.rakazo.local-agent.plist"`. Stop active tasks before unloading or updating the helper. The generator refuses to overwrite an existing plist.

## Permissions, recovery and limits

The optional lifecycle extension keeps the v1 execution payloads unchanged. New workers query `/v1/lifecycle` and explicitly request reuse; an older helper returns 404 and runs cold. The private helper configuration accepts `lifecycle: { "enabled": false, "idleTtlMs": 300000, "maxIdleSessions": 2 }`. Keep it disabled until every API/worker supports session release and existing work has drained. This is a local configuration setting, not a provider-specific environment variable.

After a successful turn, an opted-in helper may retain the same loaded native session for up to five minutes, with at most two idle sessions. Every reuse rechecks local state, account, effective policy and loaded thread metadata; the next turn explicitly reasserts the project roots and approval policy. Unverifiable configuration sources, changed instructions, a dead process or an outstanding tool process use a cold start instead. An execution never shares a process with another user, bot, thread, project, model, access level or instruction binding. Failed and cancelled turns do not enter the idle cache. Closing the helper clears both active and idle processes.

A terminal notification can arrive before a child exits. The helper briefly rechecks the process tree while retaining the project lock, and caches it only after the children have exited. A persistent child or failed check still closes the tree. Keep helper-owned native threads exclusive to the helper: opening one in another Codex client can prevent a later resume with an active-writer conflict. Operator recovery may preserve the original context in a separate fork; it must not take over an active writer or replay an uncertain input automatically.

The existing working-status line reports connection, restoration, waiting, available public summaries and structured retry notifications across clients. Summaries are bounded optional status, never answer text or raw reasoning. Missing upstream retry metadata stays a generic wait; the UI does not infer a countdown from private logs. First feedback and first reply text are timed separately. Upstream model latency and rate-limit backoff remain outside the startup optimization.

Clear, archive, deletion, execution-target changes and connection revocation release idle sessions as well as cancelling active work. Release receipts fence the old runs and retain native context for a later explicit turn; retrying a confirmed receipt cannot stop a later turn. A pending release blocks new admission until shutdown is confirmed. Discovery caches expire quickly and invalidate on local executable or credential/configuration changes. Phase diagnostics contain only stage names and monotonic durations.

Repeated cleanup of the same session and admitted-run snapshot reuses its receipt, preserving the bounded journal capacity. A Host restart finishes recorded cleanup intents without replaying user input; the interrupted native runs retain their uncertain state. Existing journal rollover requirements still apply, including the bounded release receipts. To roll back reuse, stop new admission, drain work and close idle processes before reverting to cold operation; keep the receipts and execution cursors.

The named native permission profile allows the selected project and minimal OS runtime reads, denies `.env` files and external project access, disables command network access and disables ambient MCP servers, plugins, hooks, browser/computer integrations and subagents. The active resolved profile is checked before any turn. General command escalation and permission extensions are declined automatically. Only a previously observed finite patch inside a write-enabled project can request **Allow once**. Patches whose complete preview exceeds the card limit are declined. This does not authorize a broader shell or future requests.

Approval cards identify the local project and expire after 15 minutes. Only the run's signed-in user can answer through the dedicated card endpoint; ordinary chat, model tools and generic answer endpoints cannot grant these requests. Declining a patch performs no file effect. Expired or restarted native RPCs cannot be revived by replaying a decision.

Run snapshots, cursors, output and decisions are persisted under tenant scope; content fields use the existing encryption layer. The helper writes private journals before launching. Worker recovery first requires the original host receipt and consumes events after the durable cursor. Retries of a known busy project are queued; transport reconnection is bounded. Missing receipts, event gaps and ambiguous execution fail without resubmitting the user task. A host restart marks unfinished journals uncertain. A separate process owner kills the native process group if the helper dies abruptly. New user turns may resume the native conversation; old turns are never represented as newly completed.

Active runs require a worker heartbeat (90-second lease). Waiting questions retain their native process only until the question deadline. **Stop** confirms host cancellation before the server marks work stopped, including cancellation that wins a race with initial startup. An unreachable host cannot truthfully confirm Stop; reconnect it or stop the helper locally, then retry. Clear, archive, deletion and revocation use the same cancellation boundary. API/worker shutdown releases its durable run for recovery; it does not cancel the independent helper's live turn.

Journals intentionally do not auto-evict idempotency records: the default host stops accepting new work after 128 retained runs or cancellation records and caps each run's event data at 4 MB. Stop and drain all runs before creating a fresh private state directory/connection for a new batch; preserve the old directory for audit, and never point a recovering worker at empty state. Add only explicitly authorized bot bindings to the replacement helper. The API processes at most 100 waiting native runs per reconciliation pass; this first release targets a personal local installation.

Revoke a connection in settings to disable it and stop its tasks. To invalidate a captured host token too, stop the helper, rotate the private token, restart it and create a new connection; revocation in Rakazo alone does not rotate a separate process's credential. Changing project/model/access or clearing history creates a new native session binding. Existing native Codex chats are never imported.

## A session is open in another app

The local helper and Codex Desktop run separate app-server processes. A persisted native conversation can have only one writer. If another client owns it, Rakazo rejects that run before submitting its input and displays “Local session is open in another app. Release it there, then try again.” It preserves the native reference and does not fork, take over the other client, or replay the failed input.

Release the conversation in the owning client, then send a new request from Rakazo. Some Codex versions retain idle conversations after a tab closes; if the owner remains, finish its active work and restart that owning app. Restarting only the Rakazo web service or helper cannot release another process's writer. Never delete a writer lock or session history to bypass the conflict. Independent conversations can still run against the same authorized project.

The existing error surface distinguishes failed, stopped and uncertain runs. Its recovery advice appears only on failure, because hiding it under technical details would leave the user without the action needed to continue. Only a known application failure code is persisted and presented; raw native errors and session identifiers remain private.

## Acceptance commands

Default protocol, host, runtime and UI tests are offline and use fake CLI processes. The Postgres test requires a disposable migrated database with a separate runtime role; never point it at application data. See the task evidence for the verified cases.

The real macOS sandbox check uses temporary fixture files, starts no model turn and removes its directory:

```sh
pnpm --filter @rakazo/local-agent exec tsx scripts/verify-sandbox.ts /absolute/path/to/codex
```

It must report every check true: project read, project write, denied outside reads/writes, denied secret-file reads, denied read-only writes and unchanged outside fixture. Authentication/model-catalog checks are separate from inference. Live model quality/cost evaluation is opt-in and was not used as an offline test oracle. Web screenshot coverage runs in CI; do not run the Electron E2E suite as routine local verification on a maintainer's Mac.
