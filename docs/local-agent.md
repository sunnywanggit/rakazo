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

The named native permission profile allows the selected project and minimal OS runtime reads, denies `.env` files and external project access, disables command network access and disables ambient MCP servers, plugins, hooks, browser/computer integrations and subagents. The active resolved profile is checked before any turn. General command escalation and permission extensions are declined automatically. Only a previously observed finite patch inside a write-enabled project can request **Allow once**. Patches whose complete preview exceeds the card limit are declined. This does not authorize a broader shell or future requests.

Approval cards identify the local project and expire after 15 minutes. Only the run's signed-in user can answer through the dedicated card endpoint; ordinary chat, model tools and generic answer endpoints cannot grant these requests. Declining a patch performs no file effect. Expired or restarted native RPCs cannot be revived by replaying a decision.

Run snapshots, cursors, output and decisions are persisted under tenant scope; content fields use the existing encryption layer. The helper writes private journals before launching. Worker recovery first requires the original host receipt and consumes events after the durable cursor. Retries of a known busy project are queued; transport reconnection is bounded. Missing receipts, event gaps and ambiguous execution fail without resubmitting the user task. A host restart marks unfinished journals uncertain. A separate process owner kills the native process group if the helper dies abruptly. New user turns may resume the native conversation; old turns are never represented as newly completed.

Active runs require a worker heartbeat (90-second lease). Waiting questions retain their native process only until the question deadline. **Stop** confirms host cancellation before the server marks work stopped, including cancellation that wins a race with initial startup. An unreachable host cannot truthfully confirm Stop; reconnect it or stop the helper locally, then retry. Clear, archive, deletion and revocation use the same cancellation boundary. API/worker shutdown releases its durable run for recovery; it does not cancel the independent helper's live turn.

Journals intentionally do not auto-evict idempotency records: the default host stops accepting new work after 128 retained runs or cancellation records and caps each run's event data at 4 MB. Stop and drain all runs before creating a fresh private state directory/connection for a new batch; preserve the old directory for audit, and never point a recovering worker at empty state. Add only explicitly authorized bot bindings to the replacement helper. The API processes at most 100 waiting native runs per reconciliation pass; this first release targets a personal local installation.

Revoke a connection in settings to disable it and stop its tasks. To invalidate a captured host token too, stop the helper, rotate the private token, restart it and create a new connection; revocation in Rakazo alone does not rotate a separate process's credential. Changing project/model/access or clearing history creates a new native session binding. Existing native Codex chats are never imported.

## Acceptance commands

Default protocol, host, runtime and UI tests are offline and use fake CLI processes. The Postgres test requires a disposable migrated database with a separate runtime role; never point it at application data. See the task evidence for the verified cases.

The real macOS sandbox check uses temporary fixture files, starts no model turn and removes its directory:

```sh
pnpm --filter @rakazo/local-agent exec tsx scripts/verify-sandbox.ts /absolute/path/to/codex
```

It must report every check true: project read, project write, denied outside reads/writes, denied secret-file reads, denied read-only writes and unchanged outside fixture. Authentication/model-catalog checks are separate from inference. Live model quality/cost evaluation is opt-in and was not used as an offline test oracle. Web screenshot coverage runs in CI; do not run the Electron E2E suite as routine local verification on a maintainer's Mac.
