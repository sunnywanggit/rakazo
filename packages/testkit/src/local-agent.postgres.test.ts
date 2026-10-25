import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
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
    const handles = await createApp({
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
    });
    let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
    try {
      const db = asSystem(handles.prisma);
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
        notifyOnFinish: false,
      });
      const storedBot = await db.bot.findUniqueOrThrow({ where: { id: bot.id } });
      const token = "a".repeat(64);
      host = await startLocalAgentHost({
        root: path.join(fixture.base, "host"),
        token,
        engine: fixture.engine,
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
      expect(wire).toContain('"method":"thread/resume"');
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
      const blocked = await send("question");
      await wait(blocked.runId, "waiting_input");
      await call("threads/stop", { botId: bot.id });
      await wait(blocked.runId, "cancelled");
      const status = await fetch(`${endpoint}/v1/runs/${blocked.runId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect((await status.json()).status).toBe("cancelled");
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
