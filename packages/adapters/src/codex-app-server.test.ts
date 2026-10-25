import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerEngine,
  codexLocalArguments,
  codexLocalEnvironment,
} from "./codex-app-server.js";
import { codexFixture } from "./local-agent-fixture.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

async function fixture(prompt = "inspect", access: "read" | "write" = "read") {
  const f = await codexFixture();
  cleanup.push(f.dispose);
  const emit = vi.fn(async () => undefined);
  const session = vi.fn(async () => undefined);
  const execution = await f.engine.start({
    request: { ...f.request, prompt, access },
    cwd: f.cwd,
    emit,
    session,
  });
  cleanup.push(() => execution.cancel());
  return { ...f, emit, session, execution };
}

describe("Codex native driver", () => {
  it("discovers models from the authenticated CLI", async () => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    expect(await f.engine.models()).toEqual([{ id: "fake-model", label: "Fake" }]);
  });
  it("rejects an unreviewed protocol release before starting a server", async () => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    const source = await readFile(f.executable, "utf8");
    await writeFile(f.executable, source.replace("codex-cli 0.163.0", "codex-cli 0.164.0"));
    await expect(f.engine.models()).rejects.toThrow("Unsupported");
  });
  it("streams text, binds the native session and completes only on a completed turn", async () => {
    const f = await fixture();
    expect(await f.execution.completion).toBe("completed");
    expect(f.session).toHaveBeenCalledWith("native-session");
    expect(f.emit).toHaveBeenCalledWith({ type: "text", text: "done" });
  });
  it("resumes the native thread without replaying previous user input", async () => {
    const f = await fixture();
    await f.execution.completion;
    const second = await f.engine.start({
      request: { ...f.request, runId: "second", prompt: "continue" },
      cwd: f.cwd,
      sessionRef: "native-session",
      emit: async () => undefined,
      session: async () => undefined,
    });
    await second.completion;
    const wire = (await readFile(path.join(f.base, "wire.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(wire.filter((item) => item.method === "thread/resume")).toHaveLength(1);
    expect(
      wire.filter((item) => item.method === "turn/start").map((item) => item.params.input[0].text),
    ).toEqual(["inspect", "continue"]);
  });
  it("holds structured questions until an explicit answer arrives", async () => {
    const f = await fixture("question");
    await vi.waitFor(() =>
      expect(f.emit.mock.calls.some(([event]: any[]) => event.type === "interaction")).toBe(true),
    );
    const interaction = (f.emit.mock.calls as any[]).find(
      ([event]) => event.type === "interaction",
    )[0].interaction;
    await expect(
      f.execution.respond(interaction.id, { fence: 1, decision: "answer", answers: {} }),
    ).rejects.toThrow("Incomplete");
    await f.execution.respond(interaction.id, {
      fence: 1,
      decision: "answer",
      answers: { choice: "one" },
    });
    expect(await f.execution.completion).toBe("completed");
    expect(JSON.stringify(f.emit.mock.calls)).toContain("one");
  });
  it("rejects sandbox escape approvals without performing their effect", async () => {
    const f = await fixture("escape");
    await f.execution.completion;
    await expect(readFile(path.join(f.base, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.emit.mock.calls.some(([event]: any[]) => event.type === "interaction")).toBe(false);
  });
  it("allows one bounded patch only after a human decision", async () => {
    const f = await fixture("approval", "write");
    await vi.waitFor(() =>
      expect(f.emit.mock.calls.some(([event]: any[]) => event.type === "interaction")).toBe(true),
    );
    await expect(readFile(path.join(f.cwd, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const interaction = (f.emit.mock.calls as any[]).find(
      ([event]) => event.type === "interaction",
    )[0].interaction;
    await f.execution.respond(interaction.id, { fence: 1, decision: "allow" });
    await f.execution.completion;
    expect(await readFile(path.join(f.cwd, "file.txt"), "utf8")).toBe("updated");
  });
  it("interrupts an active turn and closes the owned native process", async () => {
    const f = await fixture("wait");
    await f.execution.cancel();
    expect(await f.execution.completion).toBe("cancelled");
  });
  it("rejects a broader resolved filesystem profile before submitting work", async () => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    const engine = new CodexAppServerEngine({
      executable: f.executable,
      env: { HOME: f.base, PATH: process.env.PATH, LANG: "mismatch" },
    });
    await expect(
      engine.start({
        request: f.request,
        cwd: f.cwd,
        emit: async () => undefined,
        session: async () => undefined,
      }),
    ).rejects.toThrow("policy");
    expect(await readFile(path.join(f.base, "wire.jsonl"), "utf8")).not.toContain(
      '"method":"turn/start"',
    );
  });
  it("does not inherit server secrets, and disables ambient tool sources", () => {
    expect(
      codexLocalEnvironment({
        HOME: "/fake",
        DATABASE_URL: "fake-secret",
        SANDBOX_HOST_TOKEN: "fake-token",
        OPENAI_API_KEY: "fake-key",
        PATH: "/bin",
      }),
    ).toEqual({ HOME: "/fake", PATH: "/bin" });
    const args = codexLocalArguments("/project", "read", "policy");
    expect(args).toContain("mcp_servers={}");
    expect(args).toContain("plugins={}");
    expect(args).toContain("hooks={}");
    expect(args.join(" ")).not.toContain("danger-full-access");
  });
});
