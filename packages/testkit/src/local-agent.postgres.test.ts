import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient, LocalAgentClient } from "@rakazo/adapters";
import { runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { codexFixture } from "../../adapters/src/local-agent-fixture.js";
import { startLocalAgentHost } from "../../adapters/src/local-agent-host.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

const origin = "http://127.0.0.1:5173";
const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!available)("local Codex through the authenticated API and worker", () => {
  it("persists native sessions, requires explicit decisions, and stops blocked work", async () => {
    const fixture = await codexFixture();
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-native-api-"));
    const allowedOrigins: string[] = [];
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const sendNotice = vi.fn(async () => undefined);
    const options = {
      notifications: {
        describe: () => ({
          id: "offline",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { push: true, email: false },
        }),
        send: sendNotice,
      },
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      dataDir,
      authUrl: origin,
      webOrigin: origin,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "offline-native-fixture-key",
      localAgentAllowedOrigins: allowedOrigins,
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
    } as const;
    let handles = await createApp(options);
    let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
    try {
      let db = asSystem(handles.prisma);
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `native-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Native fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const call = async (procedure: string, body: unknown, ok = true) => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: body }),
        });
        if (!ok) {
          expect(response.status).toBeGreaterThanOrEqual(400);
          return undefined;
        }
        if (!response.ok)
          throw new Error(`${procedure}: ${response.status}: ${await response.text()}`);
        return (await response.json()).json;
      };
      const bot = await call("bots/create", {
        name: "Native fixture",
        title: "",
        description: "",
        instructions: "Inspect project",
        notifyOnFinish: true,
      });
      const storedBot = await db.bot.findUniqueOrThrow({ where: { id: bot.id } });
      const token = "a".repeat(64);
      host = await startLocalAgentHost({
        root: path.join(fixture.base, "host"),
        token,
        engine: fixture.engine,
        sessionReuse: true,
        projects: [{ id: "project", label: "Fixture", root: fixture.cwd, access: "write" }],
        bindings: [
          {
            spaceId: storedBot.spaceId,
            userId: storedBot.userId,
            botId: bot.id,
            projects: ["project"],
          },
        ],
      });
      const endpoint = `http://127.0.0.1:${host.port}`;
      allowedOrigins.push(endpoint);
      const connection = await call("localAgent/connect", {
        botId: bot.id,
        name: "Fixture",
        endpoint,
        token,
      });
      await call("localAgent/setTarget", {
        botId: bot.id,
        target: {
          connectionId: connection.id,
          projectId: "project",
          model: "fake-model",
          access: "write",
        },
      });
      const wait = async (runId: string, status: string) => {
        await expect
          .poll(
            async () => {
              const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
              if (run.status === "failed" && status !== "failed")
                throw new Error(run.error ?? "failed");
              return run.status;
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe(status);
      };
      const send = (text: string) => call("threads/send", { botId: bot.id, text });
      const first = await send("inspect");
      await wait(first.runId, "completed");
      const second = await send("inspect");
      await wait(second.runId, "completed");
      const native = await db.localAgentRun.findMany({
        where: { id: { in: [first.runId, second.runId] } },
      });
      expect(native).toHaveLength(2);
      expect(native[0]!.sessionId).toBe(native[1]!.sessionId);
      const wire = await readFile(path.join(fixture.base, "wire.jsonl"), "utf8");
      const frames = wire
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(frames.filter((frame) => frame.method === "initialize")).toHaveLength(2); // Catalog + one execution process.
      expect(frames.filter((frame) => frame.method === "thread/resume")).toHaveLength(0);
      expect(frames.filter((frame) => frame.method === "turn/start")).toHaveLength(2);
      const raw = await db.$queryRaw<
        Array<{ request: string }>
      >`SELECT request FROM local_agent_runs WHERE id = ${first.runId}`;
      expect(raw[0]!.request).not.toContain('"prompt":"inspect"');
      for (const decision of ["deny", "allow"] as const) {
        const sent = await send("approval");
        await wait(sent.runId, "waiting_input");
        const card = await db.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        const ask = (card.blocks as Array<{ kind: string; runtimeInteractionId?: string }>).find(
          (block) => block.kind === "ask",
        )!;
        await call(
          "threads/answer",
          { botId: bot.id, runId: sent.runId, messageId: card.id, answer: "allow" },
          false,
        );
        if (decision === "deny")
          await expect(access(path.join(fixture.cwd, "file.txt"))).rejects.toThrow();
        await call("localAgent/respond", {
          interactionId: ask.runtimeInteractionId,
          messageId: card.id,
          decision,
        });
        await wait(sent.runId, "completed");
        await call("localAgent/respond", {
          interactionId: ask.runtimeInteractionId,
          messageId: card.id,
          decision,
        });
        const interaction = await db.localAgentInteraction.findUniqueOrThrow({
          where: { id: ask.runtimeInteractionId! },
        });
        expect(interaction.status).toBe("delivered");
        if (decision === "deny")
          await expect(access(path.join(fixture.cwd, "file.txt"))).rejects.toThrow();
      }
      expect(await readFile(path.join(fixture.cwd, "file.txt"), "utf8")).toBe("updated");
      // A graceful API/worker restart must keep the native turn alive and consume its cursor.
      const restarting = await send("delayed");
      await expect
        .poll(async () =>
          (await db.run.findUnique({ where: { id: restarting.runId } }))?.firstResponseAt ? 1 : 0,
        )
        .toBeGreaterThan(0);
      const beforeRestart = (await readFile(path.join(fixture.base, "wire.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.includes('"method":"turn/start"')).length;
      await handles.stop();
      handles = await createApp(options);
      db = asSystem(handles.prisma);
      await wait(restarting.runId, "completed");
      const afterRestart = (await readFile(path.join(fixture.base, "wire.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.includes('"method":"turn/start"')).length;
      expect(afterRestart).toBe(beforeRestart);
      // Fault injection after a successful DB renewal covers heartbeat transport recovery.
      const cliSource = await readFile(fixture.executable, "utf8");
      await writeFile(
        fixture.executable,
        cliSource.replace("setTimeout(done, 1500)", "setTimeout(done, 6000)"),
      );
      const heartbeat = vi
        .spyOn(LocalAgentClient.prototype, "heartbeat")
        .mockRejectedValueOnce(new Error("offline fixture"));
      const reconnecting = await send("delayed");
      await wait(reconnecting.runId, "completed");
      expect(heartbeat).toHaveBeenCalled();
      heartbeat.mockRestore();
      const attempts = await db.attempt.count({ where: { runId: reconnecting.runId } });
      expect(attempts).toBeGreaterThan(1);
      const answered = await send("question");
      await wait(answered.runId, "waiting_input");
      const questionCard = await db.message.findFirstOrThrow({
        where: { runId: answered.runId, role: "bot" },
        orderBy: { seq: "desc" },
      });
      const question = (
        questionCard.blocks as Array<{ kind: string; runtimeInteractionId?: string }>
      ).find((block) => block.kind === "ask")!;
      await call(
        "localAgent/respond",
        {
          interactionId: question.runtimeInteractionId,
          messageId: questionCard.id,
          decision: "answer",
          answers: {},
        },
        false,
      );
      await call("localAgent/respond", {
        interactionId: question.runtimeInteractionId,
        messageId: questionCard.id,
        decision: "answer",
        answers: { choice: "one" },
      });
      await wait(answered.runId, "completed");
      const beforeArchive = await db.localAgentRun.findUniqueOrThrow({
        where: { id: answered.runId },
      });
      await call("bots/archive", { botId: bot.id });
      await call("bots/restore", { botId: bot.id });
      const restored = await send("inspect");
      await wait(restored.runId, "completed");
      expect(
        (await db.localAgentRun.findUniqueOrThrow({ where: { id: restored.runId } })).sessionId,
      ).toBe(beforeArchive.sessionId);
      await call("threads/clear", { botId: bot.id });
      const cleared = await send("inspect");
      await wait(cleared.runId, "completed");
      const afterClear = await db.localAgentRun.findUniqueOrThrow({ where: { id: cleared.runId } });
      expect(afterClear.sessionId).not.toBe(beforeArchive.sessionId);
      await call("localAgent/setTarget", {
        botId: bot.id,
        target: {
          connectionId: connection.id,
          projectId: "project",
          model: "fake-model",
          access: "read",
        },
      });
      const changed = await send("inspect");
      await wait(changed.runId, "completed");
      expect(
        (await db.localAgentRun.findUniqueOrThrow({ where: { id: changed.runId } })).sessionId,
      ).not.toBe(afterClear.sessionId);
      for (const spaceId of [storedBot.spaceId, "other-space"]) {
        const counts = await runAsTenant({ spaceId, userId: "other-user" }, async () =>
          Promise.all([
            handles.prisma.localAgentConnection.count(),
            handles.prisma.localAgentTarget.count(),
            handles.prisma.localAgentSession.count(),
            handles.prisma.localAgentRun.count(),
            handles.prisma.localAgentInteraction.count(),
          ]),
        );
        expect(counts).toEqual([0, 0, 0, 0, 0]);
      }
      const blocked = await send("question");
      await wait(blocked.runId, "waiting_input");
      await call("threads/stop", { botId: bot.id });
      await wait(blocked.runId, "cancelled");
      const status = await fetch(`${endpoint}/v1/runs/${blocked.runId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect((await status.json()).status).toBe("cancelled");
      expect(sendNotice.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([expect.objectContaining({ kind: "help", botId: bot.id })]),
          expect.arrayContaining([expect.objectContaining({ kind: "completion", botId: bot.id })]),
        ]),
      );
      await call("localAgent/revoke", { connectionId: connection.id });
      await call(
        "localAgent/setTarget",
        {
          botId: bot.id,
          target: {
            connectionId: connection.id,
            projectId: "project",
            model: "fake-model",
            access: "write",
          },
        },
        false,
      );
    } finally {
      await handles.stop();
      await host?.close();
      await fixture.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
