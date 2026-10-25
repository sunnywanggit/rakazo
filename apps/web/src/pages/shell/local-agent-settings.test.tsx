// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  settings: vi.fn(),
  inspect: vi.fn(),
  connect: vi.fn(),
  setTarget: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { localAgent: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { LocalAgentSettings } from "./local-agent-settings";

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
  vi.clearAllMocks();
});
const settings = {
  enabled: true,
  allowedOrigins: [],
  connections: [
    { id: "connection", name: "Local Codex", endpoint: "http://localhost:8000", enabled: true },
  ],
  target: null,
  pairing: { botId: "bot", userId: "user", spaceId: "space" },
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;

it("selects a host project/model with read-only access and saves explicitly", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.settings.mockResolvedValue(settings);
  api.inspect.mockResolvedValue({
    protocol: 1,
    engine: "codex",
    projects: [{ id: "project", label: "Project", access: "write" }],
    models: [{ id: "model", label: "Model" }],
  });
  const changed = vi.fn();
  await act(async () => root.render(<LocalAgentSettings botId="bot" onChanged={changed} />));
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Execution"]')!;
  await act(async () => {
    select.value = "connection";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(api.setTarget).not.toHaveBeenCalled();
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="Project access"]')!.value,
  ).toBe("read");
  await act(async () => button("Save execution").click());
  expect(api.setTarget).toHaveBeenCalledWith({
    botId: "bot",
    target: { connectionId: "connection", projectId: "project", model: "model", access: "read" },
  });
  expect(changed).toHaveBeenLastCalledWith(true);
});

it("keeps pairing fields hidden until requested and clears credentials on submission", async () => {
  api.settings.mockResolvedValue(settings);
  api.connect.mockRejectedValue(new Error("private endpoint details"));
  await act(async () => root.render(<LocalAgentSettings botId="bot" onChanged={vi.fn()} />));
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await act(async () => button("Connect local agent").click());
  const set = (label: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await act(async () => {
    set("Local agent endpoint", "http://localhost:8000");
    set("Pairing token", "a".repeat(64));
  });
  await act(async () => button("Connect").click());
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(container.textContent).not.toContain("private endpoint details");
});
