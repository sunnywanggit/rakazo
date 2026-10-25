import type { LocalAgentSettingsApi } from "@rakazo/chat-ui/local-agent";
import { useLocalAgentSettings } from "@rakazo/chat-ui/local-agent";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

const api: LocalAgentSettingsApi = {
  settings: (input) => rpc("localAgent/settings", input),
  inspect: (input) => rpc("localAgent/inspect", input),
  connect: (input) => rpc("localAgent/connect", input),
  setTarget: (input) => rpc("localAgent/setTarget", input),
  revoke: (input) => rpc("localAgent/revoke", input),
};
export function LocalAgentSettings({
  botId,
  onChanged,
}: {
  botId: string;
  onChanged: (active: boolean) => void;
}) {
  const state = useLocalAgentSettings(api, botId, onChanged);
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [pairing, setPairing] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  if (!state.settings?.enabled) return null;
  const target = state.target;
  const field = {
    color: tokens.foreground,
    borderColor: tokens.border,
    borderWidth: 1,
    padding: 12,
    borderRadius: 8,
  };
  return (
    <View
      pointerEvents={state.busy ? "none" : "auto"}
      accessibilityState={{ busy: state.busy }}
      style={{ gap: 12 }}
    >
      <MenuPicker
        label={t("Execution")}
        choices={[
          { key: "", label: "Rakazo" },
          ...state.settings.connections
            .filter((connection) => connection.enabled)
            .map((connection) => ({ key: connection.id, label: connection.name })),
        ]}
        value={target?.connectionId ?? ""}
        onChange={(key) => {
          if (key) void state.choose(key);
          else state.setTarget(null);
        }}
      />
      {target ? (
        <>
          <MenuPicker
            label={t("Project")}
            choices={
              state.capabilities?.projects.map((project) => ({
                key: project.id,
                label: project.label,
              })) ?? []
            }
            value={target.projectId}
            onChange={(projectId) => state.setTarget({ ...target, projectId, access: "read" })}
          />
          <MenuPicker
            label={t("Local model")}
            choices={
              state.capabilities?.models.map((model) => ({ key: model.id, label: model.label })) ??
              []
            }
            value={target.model}
            onChange={(model) => state.setTarget({ ...target, model })}
          />
          <MenuPicker
            label={t("Project access")}
            choices={[
              { key: "read", label: t("Read only") },
              ...(state.capabilities?.projects.find((project) => project.id === target.projectId)
                ?.access === "write"
                ? [{ key: "write", label: t("Read and write") }]
                : []),
            ]}
            value={target.access}
            onChange={(access) =>
              state.setTarget({ ...target, access: access === "write" ? "write" : "read" })
            }
          />
        </>
      ) : null}
      <NativeActionButton label={t("Save execution")} onPress={() => void state.save()} />
      <NativeActionButton
        label={t("Connect local agent")}
        prominence="secondary"
        onPress={() => setPairing(!pairing)}
      />
      {target ? (
        <NativeActionButton
          label={t("Revoke connection")}
          prominence="destructive"
          onPress={() => void state.revoke()}
        />
      ) : null}
      {pairing ? (
        <>
          <Text selectable style={{ color: tokens.mutedForeground }}>
            {JSON.stringify(state.settings.pairing)}
          </Text>
          <TextInput
            accessibilityLabel={t("Local agent endpoint")}
            value={endpoint}
            onChangeText={setEndpoint}
            autoCapitalize="none"
            autoCorrect={false}
            style={field}
          />
          <TextInput
            accessibilityLabel={t("Pairing token")}
            value={token}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={field}
          />
          <NativeActionButton
            label={t("Connect")}
            disabled={!endpoint || !token}
            onPress={() => {
              const credential = token;
              setToken("");
              void state.connect({ name: "Local Codex", endpoint, token: credential });
            }}
          />
        </>
      ) : null}
      {state.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t(
            "Local agent unavailable. Check the connection and stop active work before changing execution.",
          )}
        </Text>
      ) : null}
    </View>
  );
}
