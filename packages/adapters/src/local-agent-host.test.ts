import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalAgentEngine } from "@rakazo/adapter-kit";
import type { LocalAgentStart } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalAgentHost } from "./local-agent-host.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const input: LocalAgentStart = {
  scope: { spaceId: "space", userId: "owner", botId: "bot", threadId: "chat" },
  runId: "run",
  sessionId: "session",
  projectId: "project",
  model: "fake",
  access: "read",
  prompt: "Inspect the project",
  instructions: "Test instructions",
  fence: 1,
};
async function fixture(
  overrides: Partial<Parameters<typeof startLocalAgentHost>[0]> = {},
  access: "read" | "write" = "write",
) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-local-test-")));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project);
  const executions: Array<{
    emit: Parameters<LocalAgentEngine["start"]>[0]["emit"];
    finish: (result: "completed" | "cancelled") => void;
    respond: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const start = vi.fn<LocalAgentEngine["start"]>(async (request) => {
    let finish!: (result: "completed" | "cancelled") => void;
    const completion = new Promise<"completed" | "cancelled">((resolve) => {
      finish = resolve;
    });
    await request.session("native-session");
    const respond = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => {
      finish("cancelled");
    });
    executions.push({ emit: request.emit, finish, respond, cancel });
    return { completion, respond, cancel };
  });
  const engine: LocalAgentEngine = {
    id: "fake",
    models: async () => [{ id: "fake", label: "Fake model" }],
    start,
  };
  const options = {
    root: path.join(base, "state"),
    token: "a".repeat(64),
    projects: [{ id: "project", label: "Project", root: project, access }],
    bindings: [{ spaceId: "space", userId: "owner", botId: "bot", projects: ["project"] }],
    engine,
    ...overrides,
  };
  const host = await startLocalAgentHost(options);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await host.close();
    }
  };
  cleanups.push(close);
  const call = (route: string, data?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${host.port}${route}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${options.token}`, ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const begin = async (request = input) => {
    const response = await call("/v1/runs", request);
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(executions.length).toBeGreaterThan(0));
    return response;
  };
  return { options, call, start, executions, begin, close, base, port: host.port };
}

describe("local host boundary", () => {
  it("rejects relative state paths before writing credentials into a checkout", async () => {
    await expect(fixture({ root: "relative-local-state" })).rejects.toThrow("absolute");
  });
  it("authenticates every endpoint, rejects browser origins and unpaired scopes", async () => {
    const f = await fixture();
    expect(
      (await f.call("/v1/capabilities", undefined, { authorization: "Bearer wrong" })).status,
    ).toBe(401);
    expect(
      (await f.call("/v1/capabilities", undefined, { origin: "https://example.invalid" })).status,
    ).toBe(401);
    const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: f.port,
          path: "/v1/capabilities",
          headers: { authorization: `Bearer ${f.options.token}`, host: "attacker.invalid" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(invalidHost).toBe(400);
    expect(
      (await f.call("/v1/runs", { ...input, scope: { ...input.scope, userId: "other" } })).status,
    ).toBe(403);
    expect((await f.call("/v1/runs", { ...input, command: ["arbitrary"] })).status).toBe(400);
    expect((await f.call("/v1/capabilities")).status).toBe(200);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("deduplicates starts, rejects changed input and fences previous workers", async () => {
    const f = await fixture();
    await f.begin();
    await f.begin({ ...input, fence: 2 });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(
      (await f.call("/v1/runs", { ...input, prompt: "Different work", fence: 3 })).status,
    ).toBe(409);
    expect((await f.call("/v1/runs/run/cancel", { fence: 1 })).status).toBe(409);
    expect((await f.call("/v1/runs/run/cancel", { fence: 2 })).status).toBe(200);
    expect(f.executions[0]!.cancel).toHaveBeenCalledTimes(1);
  });

  it("records ordered events and resumes consumers after the acknowledged cursor", async () => {
    const f = await fixture();
    await f.begin();
    await f.executions[0]!.emit({ type: "text", text: "one" });
    await f.executions[0]!.emit({ type: "text", text: "two" });
    f.executions[0]!.finish("completed");
    await vi.waitFor(async () =>
      expect((await (await f.call("/v1/runs/run")).json()).status).toBe("completed"),
    );
    const events = (await (await f.call("/v1/runs/run/events?after=1")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(events[1].event).toEqual({ type: "terminal", status: "completed" });
    expect((await f.call("/v1/runs/run/events?after=999")).status).toBe(409);
  });

  it("answers only the matching live interaction and consumes a decision once", async () => {
    const f = await fixture();
    await f.begin();
    await f.executions[0]!.emit({
      type: "interaction",
      interaction: {
        id: "approval",
        kind: "approval",
        summary: "Run a command",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(
      (await f.call("/v1/runs/run/interactions/wrong", { fence: 1, decision: "allow" })).status,
    ).toBe(409);
    expect(
      (await f.call("/v1/runs/run/interactions/approval", { fence: 1, decision: "answer" })).status,
    ).toBe(400);
    for (let i = 0; i < 2; i++)
      expect(
        (await f.call("/v1/runs/run/interactions/approval", { fence: 1, decision: "deny" })).status,
      ).toBe(200);
    expect(f.executions[0]!.respond).toHaveBeenCalledTimes(1);
    expect(
      (await f.call("/v1/runs/run/interactions/approval", { fence: 1, decision: "allow" })).status,
    ).toBe(409);
  });

  it("keeps native session references private and reuses them only for the same scope", async () => {
    const f = await fixture();
    await f.begin();
    f.executions[0]!.finish("completed");
    await vi.waitFor(async () =>
      expect((await (await f.call("/v1/runs/run")).json()).status).toBe("completed"),
    );
    expect(JSON.stringify(await (await f.call("/v1/capabilities")).json())).not.toContain(f.base);
    await f.call("/v1/runs", { ...input, runId: "second", prompt: "Continue" });
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    expect(f.start.mock.calls[1]![0].sessionRef).toBe("native-session");
    expect(f.start.mock.calls[0]![0].request.prompt).toBe(input.prompt);
  });

  it("marks interrupted journals uncertain instead of replaying them after restart", async () => {
    const f = await fixture();
    await f.begin();
    await f.executions[0]!.emit({ type: "activity", text: "Started" });
    const journal = (await readdir(f.options.root)).find((name) => name.startsWith("run-"))!;
    const snapshot = await readFile(path.join(f.options.root, journal));
    await f.close();
    await writeFile(path.join(f.options.root, journal), snapshot, { mode: 0o600 });
    const restarted = await startLocalAgentHost(f.options);
    cleanups.push(() => restarted.close());
    const response = await fetch(`http://127.0.0.1:${restarted.port}/v1/runs/run`, {
      headers: { authorization: `Bearer ${f.options.token}` },
    });
    expect((await response.json()).status).toBe("uncertain");
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("cancels native work after lease loss", async () => {
    const f = await fixture({ leaseMs: 40 });
    await f.begin();
    await vi.waitFor(() => expect(f.executions[0]!.cancel).toHaveBeenCalledTimes(1));
    expect((await (await f.call("/v1/runs/run")).json()).status).toBe("cancelled");
  });

  it("rejects writes for read-only projects and concurrent project writers", async () => {
    const readonly = await fixture({}, "read");
    expect((await readonly.call("/v1/runs", { ...input, access: "write" })).status).toBe(403);
    expect(readonly.start).not.toHaveBeenCalled();
    const f = await fixture();
    await f.begin({ ...input, access: "write" });
    expect(
      (await f.call("/v1/runs", { ...input, runId: "second", sessionId: "second" })).status,
    ).toBe(423);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("persists cancellation before a late worker can start", async () => {
    const f = await fixture();
    const { scope, runId, projectId } = input;
    expect((await f.call("/v1/cancellations", { scope, runId, projectId })).status).toBe(200);
    expect((await (await f.call("/v1/runs", input)).json()).status).toBe("cancelled");
    expect(f.start).not.toHaveBeenCalled();
    await f.close();
    const restarted = await startLocalAgentHost(f.options);
    cleanups.push(() => restarted.close());
    const response = await fetch(`http://127.0.0.1:${restarted.port}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.options.token}` },
      body: JSON.stringify({ ...input, fence: 2 }),
    });
    expect((await response.json()).status).toBe("cancelled");
    expect(f.start).not.toHaveBeenCalled();
  });

  it("bounds retained runs and event data", async () => {
    const f = await fixture({ maxRuns: 1, maxEventBytes: 60 });
    await f.begin();
    await f.executions[0]!.emit({ type: "text", text: "x".repeat(100) });
    expect((await (await f.call("/v1/runs/run")).json()).status).toBe("failed");
    expect((await f.call("/v1/runs", { ...input, runId: "second" })).status).toBe(429);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});
