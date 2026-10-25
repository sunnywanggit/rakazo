import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalAgentClient, localAgentAllowedOrigins } from "./local-agent-client.js";
import { codexFixture } from "./local-agent-fixture.js";
import { startLocalAgentHost } from "./local-agent-host.js";
import { LocalAgentRuntime } from "./local-agent-runtime.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});
async function fixture() {
  const f = await codexFixture();
  cleanup.push(f.dispose);
  const host = await startLocalAgentHost({
    root: path.join(f.base, "host"),
    token: "a".repeat(64),
    engine: f.engine,
    projects: [{ id: "project", label: "Fixture", root: f.cwd, access: "write" }],
    bindings: [{ ...f.request.scope, projects: ["project"] }],
  });
  cleanup.push(() => host.close());
  const endpoint = `http://127.0.0.1:${host.port}`;
  const client = new LocalAgentClient({
    endpoint,
    token: "a".repeat(64),
    allowedOrigins: [endpoint],
  });
  cleanup.push(() => client.close());
  return { ...f, host, client, runtime: new LocalAgentRuntime(client) };
}
it("reattaches to a blocked process and delivers its decision without submitting a second turn", async () => {
  const f = await fixture();
  let cursor = 0,
    interactionId = "";
  for await (const event of f.runtime.run({
    ...f.request,
    prompt: "question",
    cursor,
    decisions: [],
    allowCreate: true,
  })) {
    if (event.type !== "host") throw new Error("Unexpected event");
    cursor = event.envelope.sequence;
    if (event.envelope.event.type === "interaction") {
      interactionId = event.envelope.event.interaction.id;
      break;
    }
  }
  expect((await f.client.status(f.request.runId)).status).toBe("waiting_input");
  const reconnect = new LocalAgentRuntime(f.client);
  const events = [];
  for await (const event of reconnect.run({
    ...f.request,
    prompt: "question",
    fence: 2,
    cursor,
    allowCreate: false,
    decisions: [
      {
        id: interactionId,
        value: JSON.stringify({ decision: "answer", answers: { choice: "one" } }),
      },
    ],
  }))
    events.push(event);
  expect(
    events.some(
      (event) =>
        event.type === "host" &&
        event.envelope.event.type === "terminal" &&
        event.envelope.event.status === "completed",
    ),
  ).toBe(true);
  expect(
    (await readFile(path.join(f.base, "wire.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"method":"turn/start"')),
  ).toHaveLength(1);
});
it("refuses to recreate work when recovery cannot find the original journal", async () => {
  const f = await fixture();
  await expect(async () => {
    for await (const _event of f.runtime.run({
      ...f.request,
      cursor: 0,
      decisions: [],
      allowCreate: false,
    })) {
      /* drain */
    }
  }).rejects.toThrow();
  await expect(readFile(path.join(f.base, "wire.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("requires an exact deployment origin and never accepts endpoint credentials or paths", () => {
  for (const endpoint of [
    "http://localhost:8000/path",
    "http://owner:secret@localhost:8000",
    "http://localhost:8001",
    "http://localhost:8000,https://example.test",
  ]) {
    expect(
      () =>
        new LocalAgentClient({
          endpoint,
          token: "a".repeat(64),
          allowedOrigins: ["http://localhost:8000"],
        }),
    ).toThrow();
  }
  expect(localAgentAllowedOrigins(undefined)).toEqual([]);
});

it("recovers a lost start response by attaching to the original durable run", async () => {
  const f = await fixture();
  const start = f.client.start.bind(f.client);
  vi.spyOn(f.client, "start").mockImplementationOnce(async (request, signal) => {
    await start(request, signal);
    throw new Error("lost response fixture");
  });
  await expect(async () => {
    for await (const _event of f.runtime.run({
      ...f.request,
      cursor: 0,
      decisions: [],
      allowCreate: true,
    })) {
      /* drain */
    }
  }).rejects.toThrow("lost response");
  const events = [];
  for await (const event of f.runtime.run({
    ...f.request,
    fence: 2,
    cursor: 0,
    decisions: [],
    allowCreate: false,
  }))
    events.push(event);
  expect(events.at(-1)).toMatchObject({
    type: "host",
    envelope: { event: { type: "terminal", status: "completed" } },
  });
  const starts = (await readFile(path.join(f.base, "wire.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.includes('"method":"turn/start"'));
  expect(starts).toHaveLength(1);
});
