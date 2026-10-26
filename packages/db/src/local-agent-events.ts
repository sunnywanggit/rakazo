import type { LocalAgentEnvelope, MessageBlock } from "@rakazo/contracts";
import { localAgentFailureCode } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { appendEventInTransaction, pauseRunForInputInTransaction } from "./events.js";

export interface LocalAgentEventOwner {
  runId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
}

/** Cursor, content, interaction and card are committed together under the existing thread lock. */
export async function commitLocalAgentEvent(
  prisma: PrismaClient,
  owner: LocalAgentEventOwner,
  envelope: LocalAgentEnvelope,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${owner.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: owner.runId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        threadId: owner.threadId,
        leaseOwner: owner.leaseOwner,
        leaseFence: owner.leaseFence,
        status: "running",
      },
    });
    if (!run) throw new Error("Local agent execution lease was lost");
    const native = await tx.localAgentRun.findFirst({
      where: {
        id: owner.runId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        threadId: owner.threadId,
      },
    });
    if (!native) throw new Error("Local agent run binding was lost");
    if (envelope.sequence <= native.cursor)
      return { paused: false, sequence: null, continuationRunId: null };
    if (envelope.sequence !== native.cursor + 1) throw new Error("Local agent event gap");
    const event = envelope.event;
    let sequence: number | null = null;
    let continuationRunId: string | null = null;
    if (event.type === "text" || event.type === "activity") {
      const saved = await appendEventInTransaction(tx, {
        ...owner,
        type: "thread.progress",
        payload:
          event.type === "text"
            ? { delta: event.text, streaming: true }
            : { text: event.text, activity: true },
      });
      sequence = saved.seq;
    }
    if (event.type === "interaction") {
      const interaction = event.interaction;
      await tx.localAgentInteraction.create({
        data: {
          id: interaction.id,
          spaceId: owner.spaceId,
          userId: owner.userId,
          threadId: owner.threadId,
          runId: owner.runId,
          payload: JSON.stringify(interaction),
          expiresAt: new Date(interaction.expiresAt),
        },
      });
      const block: MessageBlock = {
        kind: "ask",
        text: `Local project: ${interaction.summary}`,
        detail: interaction.detail,
        status: "pending",
        runtimeInteractionId: interaction.id,
        runtimeExpiresAt: interaction.expiresAt,
        runtimeQuestions: interaction.questions,
        ...(interaction.kind === "approval"
          ? {
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            }
          : {}),
      };
      const paused = await pauseRunForInputInTransaction(tx, {
        ...owner,
        blocks: [...(native.output ? [{ kind: "text" as const, text: native.output }] : []), block],
      });
      if (!paused) throw new Error("Local agent interaction could not be paused");
      sequence = paused.seq;
      continuationRunId = paused.continuationRunId;
    }
    if (event.type === "resolved") {
      const resolved = await tx.localAgentInteraction.updateMany({
        where: {
          id: event.interactionId,
          runId: owner.runId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          status: "decided",
        },
        data: { status: "delivered" },
      });
      if (resolved.count !== 1) throw new Error("Local agent response binding changed");
    }
    await tx.localAgentRun.update({
      where: { id: owner.runId },
      data: {
        cursor: envelope.sequence,
        ...(event.type === "text" ? { output: native.output + event.text } : {}),
        ...(event.type === "interaction" ? { output: "" } : {}),
        ...(event.type === "terminal"
          ? {
              terminalStatus: event.status,
              terminalError: event.status === "failed" ? localAgentFailureCode(event.error) : null,
            }
          : {}),
      },
    });
    return { paused: event.type === "interaction", sequence, continuationRunId };
  });
}
