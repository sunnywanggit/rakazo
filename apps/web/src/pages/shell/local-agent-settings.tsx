import { Trans } from "@lingui/react/macro";
import type { LocalAgentSettingsApi } from "@rakazo/chat-ui/local-agent";
import { useLocalAgentSettings } from "@rakazo/chat-ui/local-agent";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../../lib/rpc";

const api: LocalAgentSettingsApi = {
  settings: async (input) => rpc.localAgent.settings(input),
  inspect: async (input) => rpc.localAgent.inspect(input),
  connect: async (input) => rpc.localAgent.connect(input),
  setTarget: async (input) => rpc.localAgent.setTarget(input),
  revoke: async (input) => rpc.localAgent.revoke(input),
};
export function LocalAgentSettings({
  botId,
  onChanged,
}: {
  botId: string;
  onChanged: (active: boolean) => void;
}) {
  const state = useLocalAgentSettings(api, botId, onChanged);
  const [pairing, setPairing] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  if (!state.settings?.enabled) return null;
  const target = state.target;
  return (
    <fieldset
      disabled={state.busy}
      className="space-y-3 rounded-xl bg-muted/50 p-4"
      data-testid="local-agent-settings"
    >
      <legend className="text-sm">
        <Trans>Execution</Trans>
      </legend>
      <NativeSelect
        aria-label="Execution"
        value={target?.connectionId ?? ""}
        onChange={(event) => {
          if (event.target.value) void state.choose(event.target.value);
          else state.setTarget(null);
        }}
      >
        <NativeSelectOption value="">Rakazo</NativeSelectOption>
        {state.settings.connections
          .filter((connection) => connection.enabled)
          .map((connection) => (
            <NativeSelectOption key={connection.id} value={connection.id}>
              {connection.name}
            </NativeSelectOption>
          ))}
      </NativeSelect>
      {target ? (
        <>
          <NativeSelect
            aria-label="Project"
            value={target.projectId}
            onChange={(event) =>
              state.setTarget({ ...target, projectId: event.target.value, access: "read" })
            }
          >
            {state.capabilities?.projects.map((project) => (
              <NativeSelectOption key={project.id} value={project.id}>
                {project.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Local model"
            value={target.model}
            onChange={(event) => state.setTarget({ ...target, model: event.target.value })}
          >
            {state.capabilities?.models.map((model) => (
              <NativeSelectOption key={model.id} value={model.id}>
                {model.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Project access"
            value={target.access}
            onChange={(event) =>
              state.setTarget({
                ...target,
                access: event.target.value === "write" ? "write" : "read",
              })
            }
          >
            <NativeSelectOption value="read">
              <Trans>Read only</Trans>
            </NativeSelectOption>
            {state.capabilities?.projects.find((project) => project.id === target.projectId)
              ?.access === "write" ? (
              <NativeSelectOption value="write">
                <Trans>Read and write</Trans>
              </NativeSelectOption>
            ) : null}
          </NativeSelect>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void state.save()}>
          <Trans>Save execution</Trans>
        </Button>
        <Button variant="ghost" onClick={() => setPairing(!pairing)}>
          <Trans>Connect local agent</Trans>
        </Button>
        {target ? (
          <Button variant="ghost" onClick={() => void state.revoke()}>
            <Trans>Revoke connection</Trans>
          </Button>
        ) : null}
      </div>
      {pairing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const credential = token;
            setToken("");
            void state.connect({ name: "Local Codex", endpoint, token: credential });
          }}
        >
          <pre className="overflow-auto whitespace-pre-wrap text-xs">
            {JSON.stringify(state.settings.pairing, null, 2)}
          </pre>
          <Input
            aria-label="Local agent endpoint"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            autoComplete="off"
          />
          <Input
            aria-label="Pairing token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
          />
          <Button type="submit" disabled={!endpoint || !token}>
            <Trans>Connect</Trans>
          </Button>
        </form>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>
            Local agent unavailable. Check the connection and stop active work before changing
            execution.
          </Trans>
        </p>
      ) : null}
    </fieldset>
  );
}
