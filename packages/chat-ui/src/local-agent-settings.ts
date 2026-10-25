import type {
  LocalAgentCapabilities,
  LocalAgentSettings,
  LocalAgentTarget,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

export interface LocalAgentSettingsApi {
  settings(input: { botId: string }): Promise<LocalAgentSettings>;
  inspect(input: { connectionId: string }): Promise<LocalAgentCapabilities>;
  connect(input: {
    botId: string;
    name: string;
    endpoint: string;
    token: string;
  }): Promise<{ id: string }>;
  setTarget(input: { botId: string; target: LocalAgentTarget | null }): Promise<unknown>;
  revoke(input: { connectionId: string }): Promise<unknown>;
}

/** Shared state only; credentials and runtime policy remain server-owned. */
export function useLocalAgentSettings(
  api: LocalAgentSettingsApi,
  botId: string,
  onChanged?: (active: boolean) => void,
) {
  const [settings, setSettings] = useState<LocalAgentSettings>();
  const [capabilities, setCapabilities] = useState<LocalAgentCapabilities>();
  const [target, setTarget] = useState<LocalAgentTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setSettings(undefined);
    setCapabilities(undefined);
    setTarget(null);
    setError(false);
    setBusy(false);
    void api
      .settings({ botId })
      .then((value) => {
        if (generation.current !== version) return;
        setSettings(value);
        setTarget(value.target);
        onChanged?.(Boolean(value.target));
        if (value.target)
          return api.inspect({ connectionId: value.target.connectionId }).then((caps) => {
            if (generation.current === version) setCapabilities(caps);
          });
      })
      .catch(() => {
        if (generation.current === version) setError(true);
      });
    return () => {
      generation.current++;
    };
  }, [api, botId]);
  const action = async (operation: () => Promise<void>) => {
    if (busy) return;
    const version = generation.current;
    setBusy(true);
    setError(false);
    try {
      await operation();
    } catch {
      if (generation.current === version) setError(true);
    } finally {
      if (generation.current === version) setBusy(false);
    }
  };
  const choose = async (connectionId: string) => {
    const version = generation.current;
    const caps = await api.inspect({ connectionId });
    if (generation.current !== version) return;
    setCapabilities(caps);
    const project = caps.projects[0],
      model = caps.models[0];
    if (!project || !model) throw new Error("No available project or model");
    setTarget({ connectionId, projectId: project.id, model: model.id, access: "read" });
  };
  return {
    settings,
    capabilities,
    target,
    setTarget,
    busy,
    error,
    choose: (connectionId: string) => action(() => choose(connectionId)),
    connect: (input: { name: string; endpoint: string; token: string }) =>
      action(async () => {
        const version = generation.current;
        const connection = await api.connect({ botId, ...input });
        if (generation.current !== version) return;
        const refreshed = await api.settings({ botId });
        if (generation.current !== version) return;
        setSettings(refreshed);
        await choose(connection.id);
      }),
    save: () =>
      action(async () => {
        const version = generation.current;
        await api.setTarget({ botId, target });
        const refreshed = await api.settings({ botId });
        if (generation.current !== version) return;
        setSettings(refreshed);
        onChanged?.(Boolean(target));
      }),
    revoke: () =>
      action(async () => {
        if (!target) return;
        const version = generation.current;
        await api.revoke({ connectionId: target.connectionId });
        const refreshed = await api.settings({ botId });
        if (generation.current !== version) return;
        setSettings(refreshed);
      }),
  };
}

export function useLocalAgentExpired(deadline?: string) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!deadline) {
      setExpired(false);
      return;
    }
    const remaining = Date.parse(deadline) - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [deadline]);
  return expired;
}
