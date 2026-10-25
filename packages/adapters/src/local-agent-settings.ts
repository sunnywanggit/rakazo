import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { LocalAgentTargetSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { LocalAgentClient } from "./local-agent-client.js";

export interface LocalAgentSettingsDeps {
  prisma: PrismaClient;
  secrets: SecretStore;
  allowedOrigins: string[];
}

export async function localAgentConnectionClient(
  deps: LocalAgentSettingsDeps,
  actor: Pick<Actor, "spaceId" | "userId">,
  connectionId: string,
  allowDisabled = false,
) {
  const connection = await deps.prisma.localAgentConnection.findFirst({
    where: {
      id: connectionId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(allowDisabled ? {} : { enabled: true }),
    },
    include: { secret: true },
  });
  if (
    !connection ||
    connection.secret.spaceId !== actor.spaceId ||
    connection.secret.userId !== actor.userId
  )
    throw new IsolationError();
  const token = await deps.secrets.load(connection.secret.ciphertext, {
    recordId: connection.secret.id,
  });
  return new LocalAgentClient({
    endpoint: connection.endpoint,
    token,
    allowedOrigins: deps.allowedOrigins,
  });
}

export async function requireLocalAgentBot(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  botId: string,
) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    include: { thread: true },
  });
  if (!bot?.thread) throw new IsolationError();
  return bot;
}

export async function localAgentSettings(
  deps: LocalAgentSettingsDeps,
  actor: Actor,
  botId: string,
) {
  await requireLocalAgentBot(deps.prisma, actor, botId);
  const [connections, target] = await Promise.all([
    deps.prisma.localAgentConnection.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true, name: true, endpoint: true, enabled: true },
    }),
    deps.prisma.localAgentTarget.findFirst({
      where: { botId, spaceId: actor.spaceId, userId: actor.userId },
    }),
  ]);
  return {
    enabled: deps.allowedOrigins.length > 0,
    allowedOrigins: deps.allowedOrigins,
    connections,
    target: target ? LocalAgentTargetSchema.strip().parse(target) : null,
    pairing: { spaceId: actor.spaceId, userId: actor.userId, botId },
  };
}

export async function connectLocalAgent(
  deps: LocalAgentSettingsDeps,
  actor: Actor,
  input: { botId: string; name: string; endpoint: string; token: string },
) {
  await requireLocalAgentBot(deps.prisma, actor, input.botId);
  const client = new LocalAgentClient({
    endpoint: input.endpoint,
    token: input.token,
    allowedOrigins: deps.allowedOrigins,
  });
  try {
    await client.capabilities();
  } finally {
    await client.close();
  }
  const stored = await deps.secrets.put(input.token, {
    operationId: "local-agent.connect",
    traceId: "local-agent.connect",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: AbortSignal.timeout(15_000),
  });
  try {
    return await deps.prisma.$transaction(async (tx) => {
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          kind: "local-agent",
          ciphertext: stored.ciphertext,
        },
      });
      const connection = await tx.localAgentConnection.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: input.name,
          endpoint: new URL(input.endpoint).origin,
          secretId: stored.id,
        },
      });
      return { id: connection.id };
    });
  } catch (error) {
    await deps.secrets.delete(stored.ciphertext, { recordId: stored.id }).catch(() => undefined);
    throw error;
  }
}

export async function setLocalAgentTarget(
  deps: LocalAgentSettingsDeps,
  actor: Actor,
  botId: string,
  target: unknown,
) {
  const bot = await requireLocalAgentBot(deps.prisma, actor, botId);
  const parsed = target === null ? null : LocalAgentTargetSchema.parse(target);
  if (parsed) {
    const client = await localAgentConnectionClient(deps, actor, parsed.connectionId);
    try {
      const capabilities = await client.capabilities();
      const project = capabilities.projects.find((item) => item.id === parsed.projectId);
      if (
        !project ||
        (parsed.access === "write" && project.access !== "write") ||
        !capabilities.models.some((item) => item.id === parsed.model)
      )
        throw new Error("Local project or model is not available");
    } finally {
      await client.close();
    }
  }
  await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread!.id} FOR UPDATE`;
    if (
      await tx.run.count({
        where: { botId, spaceId: actor.spaceId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      })
    )
      throw new Error("Stop active work before changing the execution source");
    if (!parsed) {
      await tx.localAgentTarget.deleteMany({
        where: { botId, spaceId: actor.spaceId, userId: actor.userId },
      });
      return;
    }
    const existing = await tx.localAgentTarget.findFirst({
      where: { botId, spaceId: actor.spaceId, userId: actor.userId },
    });
    if (
      existing &&
      JSON.stringify(LocalAgentTargetSchema.strip().parse(existing)) === JSON.stringify(parsed)
    )
      return;
    if (
      !(await tx.localAgentConnection.findFirst({
        where: {
          id: parsed.connectionId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          enabled: true,
        },
      }))
    )
      throw new IsolationError();
    await tx.localAgentTarget.upsert({
      where: { botId },
      create: { botId, spaceId: actor.spaceId, userId: actor.userId, ...parsed },
      update: { ...parsed, revision: randomUUID() },
    });
  });
}

/** Confirm native cancellation before callers remove history or advertise that work stopped. */
export async function cancelLocalAgentRuns(
  deps: LocalAgentSettingsDeps,
  actor: Pick<Actor, "spaceId" | "userId">,
  filter: { botId?: string; threadId?: string; connectionId?: string },
) {
  const rows = await deps.prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
      ...(filter.botId ? { botId: filter.botId } : {}),
      ...(filter.threadId ? { threadId: filter.threadId } : {}),
    },
    include: {
      localAgentRun: { include: { session: true } },
      bot: { include: { localAgentTarget: true } },
    },
  });
  for (const row of rows) {
    const native = row.localAgentRun;
    const target = native?.session ?? row.bot.localAgentTarget;
    if (!target || (filter.connectionId && target.connectionId !== filter.connectionId)) continue;
    const client = await localAgentConnectionClient(deps, actor, target.connectionId, true);
    try {
      const status = await client.stop({
        scope: {
          spaceId: row.spaceId,
          userId: row.userId,
          botId: row.botId,
          threadId: row.threadId,
        },
        projectId: target.projectId,
        runId: row.id,
      });
      if (!["cancelled", "completed", "failed", "uncertain"].includes(status.status))
        throw new Error("Local cancellation was not confirmed");
    } finally {
      await client.close();
    }
  }
}
