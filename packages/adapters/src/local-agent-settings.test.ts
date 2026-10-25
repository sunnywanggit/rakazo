import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { LocalAgentClient } from "./local-agent-client.js";
import { cancelLocalAgentRuns } from "./local-agent-settings.js";

afterEach(() => vi.restoreAllMocks());

it("releases historical idle sessions under the same tenant predicates after cancellation", async () => {
  const actor = { spaceId: "space", userId: "owner" };
  const findMany = vi.fn(async () => [
    {
      ...actor,
      id: "session",
      botId: "bot",
      threadId: "chat",
      connectionId: "connection",
      projectId: "project",
    },
  ]);
  const prisma = {
    run: { findMany: vi.fn(async () => []) },
    localAgentSession: { findMany },
    localAgentConnection: {
      findFirst: vi.fn(async () => ({
        endpoint: "https://helper.example.test",
        secret: { ...actor, id: "secret", ciphertext: "encrypted-fixture" },
      })),
    },
  } as unknown as PrismaClient;
  const release = vi.spyOn(LocalAgentClient.prototype, "release").mockResolvedValue();
  vi.spyOn(LocalAgentClient.prototype, "close").mockResolvedValue();
  const secrets = { load: async () => "a".repeat(64) } as unknown as SecretStore;
  await cancelLocalAgentRuns(
    { prisma, secrets, allowedOrigins: ["https://helper.example.test"] },
    actor,
    { botId: "bot" },
  );
  expect(findMany).toHaveBeenCalledWith({ where: { ...actor, botId: "bot" } });
  expect(release).toHaveBeenCalledWith({
    scope: { ...actor, botId: "bot", threadId: "chat" },
    sessionId: "session",
    projectId: "project",
    idempotencyKey: expect.any(String),
  });
});
