import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAgentSessionInUseError } from "@rakazo/adapter-kit";
import type { LocalAgentEvent } from "@rakazo/contracts";
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
  const emit = vi.fn<(event: LocalAgentEvent) => Promise<void>>(async () => undefined);
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
  it("classifies only the exact native resume writer conflict and never resubmits input", async () => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    const source = await readFile(f.executable, "utf8");
    await writeFile(
      f.executable,
      source.replace(
        "if (m.method === 'thread/start' || m.method === 'thread/resume')",
        "if (m.method === 'thread/resume') { send({id:m.id,error:{code:-32600,message:'thread '+m.params.threadId+' already has an active writer'}}); return; } if (m.method === 'thread/start')",
      ),
    );
    const session = vi.fn(async () => undefined);
    await expect(
      f.engine.start({
        request: f.request,
        cwd: f.cwd,
        sessionRef: "native-session",
        session,
        emit: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(LocalAgentSessionInUseError);
    expect(session).not.toHaveBeenCalled();
    const wire = await readFile(path.join(f.base, "wire.jsonl"), "utf8");
    expect(wire).not.toContain('"method":"turn/start"');
    expect(wire).not.toContain('"method":"thread/fork"');
    await writeFile(
      f.executable,
      source.replace(
        "if (m.method === 'thread/start' || m.method === 'thread/resume')",
        "if (m.method === 'thread/resume') { send({id:m.id,error:{code:-32600,message:'PRIVATE_NATIVE_DETAILS'}}); return; } if (m.method === 'thread/start')",
      ),
    );
    await expect(
      f.engine.start({
        request: f.request,
        cwd: f.cwd,
        sessionRef: "native-session",
        session,
        emit: async () => undefined,
      }),
    ).rejects.toThrow("Codex request was rejected");
  });
  it("invalidates every coalesced discovery caller when authentication changes in flight", async () => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    const source = await readFile(f.executable, "utf8");
    await writeFile(
      f.executable,
      source.replace(
        "if (m.method === 'model/list') reply(m.id,{data:[{id:'fake-model',displayName:'Fake'}],nextCursor:null});",
        "if (m.method === 'model/list') { fs.writeFileSync(path.join(process.env.HOME,'model-requested'),'ready'); const deliver=()=>{ if(fs.existsSync(path.join(process.env.HOME,'allow-model-result'))) reply(m.id,{data:[{id:'fake-model',displayName:'Fake'}],nextCursor:null}); else setTimeout(deliver,5); }; deliver(); }",
      ),
    );
    const results = Promise.allSettled([f.engine.models(), f.engine.models()]);
    await vi.waitFor(
      async () =>
        expect(await readFile(path.join(f.base, "model-requested"), "utf8")).toBe("ready"),
      { timeout: 10_000 },
    );
    await mkdir(path.join(f.base, ".codex"), { recursive: true });
    await writeFile(path.join(f.base, ".codex/auth.json"), "changed fixture authentication");
    await writeFile(path.join(f.base, "allow-model-result"), "ready");
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(await f.engine.models()).toEqual([{ id: "fake-model", label: "Fake" }]);
  });
  it("coalesces model discovery and invalidates its cache when local authentication changes", async () => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    await Promise.all([f.engine.models(), f.engine.models(), f.engine.models()]);
    const wire = async () =>
      (await readFile(path.join(f.base, "wire.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    expect((await wire()).filter((item) => item.method === "model/list")).toHaveLength(1);
    await f.engine.models();
    expect((await wire()).filter((item) => item.method === "model/list")).toHaveLength(1);
    await mkdir(path.join(f.base, ".codex"));
    await writeFile(path.join(f.base, ".codex/auth.json"), "fake credential generation");
    await f.engine.models();
    expect((await wire()).filter((item) => item.method === "model/list")).toHaveLength(2);
    expect(
      (await readFile(path.join(f.base, "version-probes"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });
  it("expires discovery caches using a monotonic clock and emits only bounded timing metadata", async () => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const timings: Array<{ phase: string; durationMs: number }> = [];
    const engine = new CodexAppServerEngine({
      executable: f.executable,
      env: { HOME: f.base, PATH: process.env.PATH },
      onTiming: (sample) => timings.push(sample),
    });
    cleanup.push(() => engine.close());
    try {
      await engine.models();
      now += 31_000;
      await engine.models();
      now += 301_000;
      await engine.models();
      expect(
        (await readFile(path.join(f.base, "version-probes"), "utf8")).trim().split("\n"),
      ).toHaveLength(2);
      expect(
        timings.every(
          (sample) =>
            Object.keys(sample).sort().join() === "durationMs,phase" &&
            Number.isFinite(sample.durationMs),
        ),
      ).toBe(true);
      expect(JSON.stringify(timings)).not.toContain(f.base);
    } finally {
      clock.mockRestore();
    }
  });
  it("streams public progress and survives native rate-limit retries without resubmitting input", async () => {
    const f = await fixture("progress");
    expect(await f.execution.completion).toBe("completed");
    const events = f.emit.mock.calls.map(([event]) => event) as any[];
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("onetwo");
    expect(events).toContainEqual({ type: "activity", text: "Public summary" });
    expect(events).toContainEqual({ type: "activity", text: "Rate limited; waiting to retry…" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
    const wire = (await readFile(path.join(f.base, "wire.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(wire.filter((item) => item.method === "turn/start")).toHaveLength(1);
    expect(wire.find((item) => item.method === "turn/start").params.summary).toBe("concise");
    expect(wire.find((item) => item.method === "turn/start").params.effort).toBeUndefined();
  });
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
  it("resumes long native conversations without hydrating previous turns", async () => {
    const f = await fixture();
    await f.execution.completion;
    const source = await readFile(f.executable, "utf8");
    await writeFile(
      f.executable,
      source.replace(
        "thread:{id:thread},cwd",
        "thread:{id:thread,turns:m.method==='thread/resume'&&!m.params.excludeTurns?[{text:'x'.repeat(1100000)}]:[]},cwd",
      ),
    );
    const resumed = await f.engine.start({
      request: { ...f.request, runId: "next", prompt: "continue" },
      cwd: f.cwd,
      sessionRef: "native-session",
      emit: async () => undefined,
      session: async () => undefined,
    });
    cleanup.push(() => resumed.cancel());
    expect(await resumed.completion).toBe("completed");
    const wire = (await readFile(path.join(f.base, "wire.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(wire.find((item) => item.method === "thread/resume").params.excludeTurns).toBe(true);
    expect(wire.filter((item) => item.method === "turn/start")).toHaveLength(2);
  });
  it("forwards synchronous native stdout bursts without dropping a response", async () => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    const source = await readFile(f.executable, "utf8");
    await writeFile(
      f.executable,
      source
        .replace(
          "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
          "const send = value => { const bytes=Buffer.from(JSON.stringify(value)+'\\n'); let offset=0; while(offset<bytes.length) offset+=fs.writeSync(1,bytes,offset,bytes.length-offset); };",
        )
        .replace("thread:{id:thread},cwd", "thread:{id:thread},padding:'x'.repeat(700000),cwd"),
    );
    const execution = await f.engine.start({
      request: f.request,
      cwd: f.cwd,
      session: async () => undefined,
      emit: async () => undefined,
    });
    cleanup.push(() => execution.cancel());
    expect(await execution.completion).toBe("completed");
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

it.each(["active", "idle"])(
  "kills the owned native process after an abrupt host exit while %s",
  async (phase) => {
    const f = await codexFixture();
    cleanup.push(f.dispose);
    const source = await readFile(f.executable, "utf8");
    await writeFile(
      f.executable,
      source
        .replace(
          "if (prompt === 'wait') return;",
          "if (prompt === 'wait') { setTimeout(() => fs.writeFileSync(path.join(process.env.HOME,'orphan-effect'),'bad'), 1200); return; }",
        )
        .replace(
          "send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'done'}}); done();",
          "setTimeout(() => fs.writeFileSync(path.join(process.env.HOME,'orphan-effect'),'bad'), 1200); send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'done'}}); done();",
        ),
    );
    const driver = fileURLToPath(new URL("./codex-app-server.ts", import.meta.url));
    const code = `import { CodexAppServerEngine } from ${JSON.stringify(driver)};
    const engine = new CodexAppServerEngine({ executable: ${JSON.stringify(f.executable)}, env: { HOME: ${JSON.stringify(f.base)}, PATH: process.env.PATH } });
    const execution = await engine.start({ request: ${JSON.stringify({ ...f.request, prompt: phase === "idle" ? "inspect" : "wait" })}, reuse: ${phase === "idle"}, cwd: ${JSON.stringify(f.cwd)}, session: async () => {}, emit: async () => {} });
    ${phase === "idle" ? "await execution.completion;" : ""}
    process.stdout.write('ready\\n'); await execution.completion;`;
    const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanup.push(async () => {
      host.kill("SIGKILL");
    });
    await new Promise<void>((resolve, reject) => {
      host.stdout.once("data", () => resolve());
      host.once("error", reject);
      host.once("exit", () => reject(new Error("Host exited before startup")));
    });
    host.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(readFile(path.join(f.base, "orphan-effect"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("declines a patch whose full preview cannot fit in the approval card", async () => {
  const f = await codexFixture();
  cleanup.push(f.dispose);
  const source = await readFile(f.executable, "utf8");
  await writeFile(f.executable, source.replace("diff:'+updated'", `diff:'${"x".repeat(16001)}'`));
  const emit = vi.fn(async () => undefined);
  const execution = await f.engine.start({
    request: { ...f.request, prompt: "approval", access: "write" },
    cwd: f.cwd,
    session: async () => {},
    emit,
  });
  cleanup.push(() => execution.cancel());
  await execution.completion;
  expect(emit.mock.calls.some(([event]: any[]) => event.type === "interaction")).toBe(false);
  await expect(readFile(path.join(f.cwd, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});
