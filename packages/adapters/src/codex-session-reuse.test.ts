import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalAgentStart } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { codexFixture } from "./local-agent-fixture.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});
async function fixture() {
  const f = await codexFixture();
  cleanup.push(f.dispose);
  let reference: string | undefined,
    number = 0;
  const begin = async (overrides: Partial<LocalAgentStart> = {}, reuse = true) => {
    const emit = vi.fn(async (_event: unknown) => {});
    const execution = await f.engine.start({
      request: { ...f.request, runId: `run-${++number}`, ...overrides },
      cwd: f.cwd,
      sessionRef: reference,
      reuse,
      session: async (value) => {
        reference = value;
      },
      emit,
    });
    return { ...execution, emit };
  };
  const wire = async () =>
    (await readFile(path.join(f.base, "wire.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { ...f, begin, wire };
}

it("uses one process and one loaded thread for two turns while revalidating account and policy", async () => {
  const f = await fixture();
  expect(await (await f.begin()).completion).toBe("completed");
  const next = await f.begin();
  expect(await next.completion).toBe("completed");
  const wire = await f.wire();
  expect(wire.filter((m) => m.method === "initialize")).toHaveLength(1);
  expect(wire.filter((m) => m.method === "thread/start")).toHaveLength(1);
  expect(wire.filter((m) => m.method === "thread/resume")).toHaveLength(0);
  expect(wire.filter((m) => m.method === "thread/read")).toHaveLength(1);
  expect(wire.filter((m) => m.method === "account/read")).toHaveLength(2);
  expect(wire.filter((m) => m.method === "config/read")).toHaveLength(2);
  expect(wire.filter((m) => m.method === "turn/start")).toHaveLength(2);
});

it("canonicalizes native maps before comparing effective configuration", async () => {
  const f = await fixture();
  const source = await readFile(f.executable, "utf8");
  await writeFile(
    f.executable,
    source
      .replace("const args =", "let order = 0; const args =")
      .replace(
        "web_search:'disabled'",
        "order_table:Object.fromEntries((++order%2?['a','b']:['b','a']).map(v=>[v,v])),web_search:'disabled'",
      ),
  );
  await (await f.begin()).completion;
  await (await f.begin()).completion;
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(1);
});

it.each(["AGENTS.md", ".codex/config.toml"])(
  "cold-resumes after project instructions or configuration change: %s",
  async (file) => {
    const f = await fixture();
    await (await f.begin()).completion;
    const target = path.join(f.cwd, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "fixture generation changed");
    await (await f.begin()).completion;
    expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(2);
    expect((await f.wire()).filter((m) => m.method === "thread/resume")).toHaveLength(1);
  },
);

it.each([
  { model: "other-model" },
  { access: "write" as const },
  { instructions: "updated fixture instructions" },
  { scope: { spaceId: "space", userId: "other", botId: "bot", threadId: "chat" } },
])("does not share a process across a changed execution binding: %j", async (selection) => {
  const f = await fixture();
  await (await f.begin()).completion;
  await (await f.begin(selection)).completion;
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(2);
});

it("releases idle resources while preserving native context for a later explicit turn", async () => {
  const f = await fixture();
  await (await f.begin()).completion;
  await f.engine.release(f.request);
  await (await f.begin()).completion;
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(2);
  expect((await f.wire()).filter((m) => m.method === "thread/resume")).toHaveLength(1);
});

it("closing an old run handle cannot cancel the next turn sharing its process", async () => {
  const f = await fixture();
  const old = await f.begin();
  await old.completion;
  const next = await f.begin({ prompt: "delayed" });
  await old.cancel();
  expect(await next.completion).toBe("completed");
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(1);
});

it("never retains a cancelled process", async () => {
  const f = await fixture();
  const waiting = await f.begin({ prompt: "wait" });
  await waiting.cancel();
  expect(await waiting.completion).toBe("cancelled");
  await (await f.begin()).completion;
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(2);
});

it("drops late events from the previous native turn", async () => {
  const f = await fixture();
  await (await f.begin({ prompt: "late-first" })).completion;
  const next = await f.begin({ prompt: "late-second" });
  await next.completion;
  expect(next.emit.mock.calls.map(([event]) => event)).toContainEqual({
    type: "text",
    text: "current",
  });
  expect(JSON.stringify(next.emit.mock.calls)).not.toContain("STALE_TURN_FIXTURE");
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(1);
});

it("does not retain a harness that still owns a background tool", async () => {
  const f = await fixture();
  await (await f.begin({ prompt: "background-tool" })).completion;
  await (await f.begin()).completion;
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(2);
});

it("waits briefly for exiting descendants before retaining an idle harness", async () => {
  const f = await fixture();
  await (await f.begin({ prompt: "brief-background-tool" })).completion;
  await (await f.begin()).completion;
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(1);
});

it("invalidates an idle session when local authentication changes", async () => {
  const f = await fixture();
  await (await f.begin()).completion;
  await mkdir(path.join(f.base, ".codex"), { recursive: true });
  await writeFile(path.join(f.base, ".codex/auth.json"), "new fixture generation");
  await (await f.begin()).completion;
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(2);
});

it("fences release during thread setup before any input is submitted", async () => {
  const f = await fixture();
  let ready!: () => void, continueSetup!: () => void;
  const observed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    continueSetup = resolve;
  });
  const starting = f.engine.start({
    request: f.request,
    cwd: f.cwd,
    reuse: true,
    emit: async () => {},
    session: async () => {
      ready();
      await gate;
    },
  });
  const outcome = expect(starting).rejects.toThrow("changed");
  await observed;
  await f.engine.release(f.request);
  continueSetup();
  await outcome;
  expect((await f.wire()).filter((m) => m.method === "turn/start")).toHaveLength(0);
});

it("falls back to cold turns when instruction-source coverage is unavailable", async () => {
  const f = await fixture();
  const source = await readFile(f.executable, "utf8");
  await writeFile(f.executable, source.replace(",instructionSources:[]", ""));
  await (await f.begin()).completion;
  await (await f.begin()).completion;
  expect((await f.wire()).filter((m) => m.method === "initialize")).toHaveLength(2);
});

it("refuses a changed effective sandbox before submitting another turn", async () => {
  const f = await fixture();
  const source = await readFile(f.executable, "utf8");
  await writeFile(
    f.executable,
    source.replace(
      "if (process.env.LANG === 'mismatch')",
      "if (process.env.LANG === 'mismatch' || fs.existsSync(path.join(process.env.HOME,'broader-policy')))",
    ),
  );
  await (await f.begin()).completion;
  await writeFile(path.join(f.base, "broader-policy"), "fixture");
  await expect(f.begin()).rejects.toThrow("policy");
  expect((await f.wire()).filter((m) => m.method === "turn/start")).toHaveLength(1);
});
