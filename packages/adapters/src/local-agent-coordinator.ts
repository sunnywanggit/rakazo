import type { JobPublisher, NotificationProvider } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { LocalAgentStartSchema } from "@rakazo/contracts";
import { localAgentFailureMessage } from "@rakazo/core";
import type { LocalAgentEventOwner, ThreadEvents } from "@rakazo/db";
import { commitLocalAgentEvent, runAsSystem } from "@rakazo/db";
import { notifyRun } from "./executor.js";
import { LocalAgentBusyError, LocalAgentTransportError } from "./local-agent-client.js";
import { LocalAgentRuntime } from "./local-agent-runtime.js";
import type { LocalAgentSettingsDeps } from "./local-agent-settings.js";
import { localAgentConnectionClient } from "./local-agent-settings.js";

class UnsupportedLocalTask extends Error {}

type Deps = LocalAgentSettingsDeps & {
  events: ThreadEvents;
  jobs: JobPublisher;
  shutdownSignal?: AbortSignal;
  notifications?: NotificationProvider;
};

/** A separate execution branch keeps native runs out of model credential and Docker orchestration. */
export class LocalAgentCoordinator {
  constructor(private readonly deps: Deps) {}

  async continueRun(runId: string, workerId: string, onRunStarted?: () => void): Promise<boolean> {
    const { prisma, events, jobs } = this.deps;
    const run = await prisma.run.findFirst({
      where: {
        id: runId,
        OR: [{ localAgentRun: { isNot: null } }, { bot: { localAgentTarget: { isNot: null } } }],
      },
      include: {
        bot: { include: { localAgentTarget: true } },
        task: true,
        thread: true,
        localAgentRun: true,
        sourceMessage: { select: { blocks: true } },
      },
    });
    if (!run) return false;
    if (
      ["completed", "failed", "cancelled", "waiting_input", "waiting_takeover"].includes(run.status)
    )
      return true;
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      if (
        await tx.run.findFirst({
          where: {
            botId: run.botId,
            id: { not: runId },
            OR: [
              { status: "waiting_input" },
              { status: { in: ["running", "leased"] }, leaseExpiresAt: { gt: new Date() } },
            ],
          },
          select: { id: true },
        })
      )
        return null;
      const fence = run.leaseFence + 1;
      const leased = await tx.run.updateMany({
        where: {
          id: runId,
          leaseFence: run.leaseFence,
          AND: [{ OR: [{ wakeAt: null }, { wakeAt: { lte: new Date() } }] }],
          OR: [
            { status: "queued" },
            { status: { in: ["running", "leased"] }, leaseExpiresAt: { lte: new Date() } },
          ],
        },
        data: {
          status: "running",
          leaseOwner: workerId,
          leaseFence: fence,
          leaseExpiresAt: new Date(Date.now() + 90_000),
          startedAt: run.startedAt ?? new Date(),
          wakeAt: null,
          error: null,
        },
      });
      if (leased.count !== 1) return null;
      const attempt = await tx.attempt.create({ data: { runId, fence, status: "running" } });
      return { fence, attemptId: attempt.id };
    });
    if (!claimed) return true;
    onRunStarted?.();
    const owner: LocalAgentEventOwner = {
      runId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      threadId: run.threadId,
      attemptId: claimed.attemptId,
      leaseOwner: workerId,
      leaseFence: claimed.fence,
    };
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    this.deps.shutdownSignal?.addEventListener("abort", shutdown, { once: true });
    if (this.deps.shutdownSignal?.aborted) controller.abort();
    let client: Awaited<ReturnType<typeof localAgentConnectionClient>> | undefined;
    let paused = false;
    let leaseLost = false;
    let transportLost = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || paused) return;
      renewing = true;
      void (async () => {
        const renewed = await prisma.run.updateMany({
          where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: claimed.fence },
          data: { leaseExpiresAt: new Date(Date.now() + 90_000) },
        });
        if (renewed.count !== 1) {
          leaseLost = true;
          controller.abort();
          return;
        }
        if (client)
          await client.heartbeat(runId, claimed.fence).catch(() => {
            transportLost = true;
            controller.abort();
          });
      })()
        .catch(() => {
          leaseLost = true;
          controller.abort();
        })
        .finally(() => {
          renewing = false;
        });
    }, 5_000);
    heartbeat.unref();
    try {
      if (
        !["user", "follow_up"].includes(run.trigger) ||
        run.thread.botId !== run.botId ||
        run.bot.userId !== run.userId ||
        run.bot.spaceId !== run.spaceId
      )
        throw new UnsupportedLocalTask("Local agents accept direct chat tasks only");
      const blocks = run.sourceMessage?.blocks;
      if (
        Array.isArray(blocks) &&
        blocks.some(
          (block) =>
            block &&
            typeof block === "object" &&
            ["image", "file", "video", "audio"].includes(String((block as { kind?: string }).kind)),
        )
      )
        throw new UnsupportedLocalTask("Use files in the selected local project");
      let native = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
        if (
          !(await tx.run.findFirst({
            where: {
              id: runId,
              status: "running",
              leaseOwner: workerId,
              leaseFence: claimed.fence,
            },
          }))
        )
          throw new Error("Local execution lease changed");
        let existing = await tx.localAgentRun.findUnique({
          where: { id: runId },
          include: { session: true },
        });
        const target =
          existing?.session ??
          (await tx.localAgentTarget.findFirst({
            where: { botId: run.botId, spaceId: run.spaceId, userId: run.userId },
          }));
        if (!target) throw new Error("Local execution source is unavailable");
        await tx.$queryRaw`SELECT id FROM local_agent_connections WHERE id = ${target.connectionId} FOR SHARE`;
        if (
          !existing?.terminalStatus &&
          !(await tx.localAgentConnection.findFirst({
            where: {
              id: target.connectionId,
              spaceId: run.spaceId,
              userId: run.userId,
              enabled: true,
            },
          }))
        )
          throw new Error("Local connection is disabled");
        if (!existing) {
          const selection = {
            spaceId: run.spaceId,
            userId: run.userId,
            botId: run.botId,
            threadId: run.threadId,
            connectionId: target.connectionId,
            projectId: target.projectId,
            model: target.model,
            access: target.access,
            generation: `${run.thread.historyCompactionGeneration}:${"revision" in target ? target.revision : ""}`,
          };
          const session = await tx.localAgentSession.upsert({
            where: {
              spaceId_userId_botId_threadId_connectionId_projectId_model_access_generation:
                selection,
            },
            create: selection,
            update: {},
          });
          const request = LocalAgentStartSchema.parse({
            scope: {
              spaceId: run.spaceId,
              userId: run.userId,
              botId: run.botId,
              threadId: run.threadId,
            },
            runId,
            sessionId: session.id,
            projectId: target.projectId,
            model: target.model,
            access: target.access,
            prompt: run.task.prompt,
            instructions: run.bot.instructions,
            fence: claimed.fence,
          });
          existing = await tx.localAgentRun.create({
            data: {
              id: runId,
              spaceId: run.spaceId,
              userId: run.userId,
              threadId: run.threadId,
              sessionId: session.id,
              request: JSON.stringify(request),
              output: "",
              hostFence: claimed.fence,
            },
            include: { session: true },
          });
        } else {
          await tx.localAgentRun.update({
            where: { id: runId },
            data: { hostFence: claimed.fence },
          });
        }
        return existing;
      });
      const finalize = async () => {
        const state = await prisma.localAgentRun.findUniqueOrThrow({ where: { id: runId } });
        if (!state.terminalStatus) return false;
        const completed = state.terminalStatus === "completed";
        const result = await events.finalizeRun({
          ...owner,
          taskId: run.taskId,
          ...(completed
            ? {
                outcome: "completed" as const,
                blocks: state.output ? [{ kind: "text" as const, text: state.output }] : [],
              }
            : {
                outcome: "failed" as const,
                error: localAgentFailureMessage(state.terminalStatus, state.terminalError),
              }),
        });
        if (result !== false && result.continuationRunId)
          await jobs.enqueue(runContinueJob(result.continuationRunId));
        if (result)
          await notifyRun(this.deps, run, {
            botId: run.botId,
            threadId: run.threadId,
            title: run.bot.name,
            kind: completed ? "completion" : "failure",
            body: completed
              ? "Local project task completed"
              : state.terminalStatus === "cancelled"
                ? "Local project task stopped"
                : "Local project task failed",
          });
        return true;
      };
      if (await finalize()) return true;
      client = await localAgentConnectionClient(this.deps, run, native.session.connectionId);
      const decisions = await prisma.localAgentInteraction.findMany({
        where: { runId, spaceId: run.spaceId, userId: run.userId, status: "decided" },
        select: { id: true, decision: true },
      });
      const request = LocalAgentStartSchema.parse({
        ...JSON.parse(native.request),
        fence: claimed.fence,
      });
      const runtime = new LocalAgentRuntime(client);
      const previousAttempt = run.localAgentRun
        ? await prisma.attempt.findFirst({
            where: { runId, fence: { lt: claimed.fence } },
            orderBy: { fence: "desc" },
          })
        : null;
      if (
        request.runId !== runId ||
        request.sessionId !== native.sessionId ||
        request.scope.spaceId !== run.spaceId ||
        request.scope.userId !== run.userId ||
        request.scope.botId !== run.botId ||
        request.scope.threadId !== run.threadId ||
        request.projectId !== native.session.projectId
      )
        throw new Error("Native binding changed");
      for await (const event of runtime.run(
        {
          ...request,
          cursor: native.cursor,
          allowCreate: !run.localAgentRun || previousAttempt?.error === "local_project_busy",
          decisions: decisions.flatMap((decision) =>
            decision.decision ? [{ id: decision.id, value: decision.decision }] : [],
          ),
        },
        { signal: controller.signal },
      )) {
        if (event.type !== "host") throw new Error("Invalid local runtime event");
        const committed = await commitLocalAgentEvent(prisma, owner, event.envelope);
        if (committed.sequence !== null) await events.notify(run.threadId, committed.sequence);
        if (committed.continuationRunId)
          await jobs.enqueue(runContinueJob(committed.continuationRunId));
        if (committed.paused) {
          paused = true;
          await notifyRun(this.deps, run, {
            botId: run.botId,
            threadId: run.threadId,
            title: run.bot.name,
            kind: "help",
            body: "Local project needs your input",
          });
          return true;
        }
      }
      native = await prisma.localAgentRun.findUniqueOrThrow({
        where: { id: runId },
        include: { session: true },
      });
      if (!(await finalize()))
        throw new LocalAgentTransportError("Local stream ended without a terminal result");
      return true;
    } catch (error) {
      const shuttingDown = this.deps.shutdownSignal?.aborted;
      const busy = error instanceof LocalAgentBusyError;
      const retryable =
        (error instanceof LocalAgentTransportError || transportLost) &&
        (await prisma.attempt.count({ where: { runId, error: "local_transport" } })) < 3;
      if ((busy || retryable || shuttingDown) && !leaseLost) {
        const wakeAt = new Date(Date.now() + (shuttingDown ? 0 : 5_000));
        const queued = await prisma.run.updateMany({
          where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: claimed.fence },
          data: { status: "queued", leaseOwner: null, leaseExpiresAt: null, wakeAt },
        });
        await prisma.attempt.updateMany({
          where: { id: claimed.attemptId, status: "running" },
          data: {
            status: "failed",
            finishedAt: new Date(),
            error: busy ? "local_project_busy" : "local_transport",
          },
        });
        if (queued.count && !shuttingDown)
          await jobs.enqueue({ ...runContinueJob(runId), availableAt: wakeAt });
        return true;
      }
      // The immutable request remains durable. Never retry it as a fresh model or command job.
      if (client && !leaseLost) await client.cancel(runId, claimed.fence).catch(() => undefined);
      if (!leaseLost) {
        const settled = await events.finalizeRun({
          ...owner,
          taskId: run.taskId,
          outcome: "failed",
          error:
            error instanceof UnsupportedLocalTask
              ? error.message
              : "Local agent unavailable or execution could not be confirmed; the task was not replayed",
        });
        if (settled !== false && settled.continuationRunId)
          await jobs.enqueue(runContinueJob(settled.continuationRunId));
      }
      return true;
    } finally {
      clearInterval(heartbeat);
      this.deps.shutdownSignal?.removeEventListener("abort", shutdown);
      await client?.close().catch(() => undefined);
    }
  }

  /** Blocked native turns have no worker iterator. Reconcile expiry and host restarts explicitly. */
  async reconcile() {
    const rows = await this.deps.prisma.localAgentRun.findMany({
      where: { run: { status: "waiting_input" } },
      include: {
        run: true,
        session: { include: { connection: true } },
        interactions: { where: { status: "pending" } },
      },
      take: 100,
    });
    for (const row of rows) {
      let ended =
        !row.session.connection.enabled ||
        row.interactions.some((interaction) => interaction.expiresAt <= new Date());
      if (!ended) {
        let client: Awaited<ReturnType<typeof localAgentConnectionClient>> | undefined;
        try {
          client = await localAgentConnectionClient(this.deps, row, row.session.connectionId);
          ended = !["starting", "running", "waiting_input"].includes(
            (await client.status(row.id)).status,
          );
        } catch {
          /* A temporary outage must not send a second task or grant a pending request. */
        } finally {
          await client?.close().catch(() => undefined);
        }
      }
      if (ended) {
        await this.deps.prisma.localAgentInteraction.updateMany({
          where: { runId: row.id, status: "pending" },
          data: { status: "expired" },
        });
        const queued = await this.deps.prisma.run.updateMany({
          where: { id: row.id, status: "waiting_input" },
          data: { status: "queued", wakeAt: null },
        });
        if (queued.count) await this.deps.jobs.enqueue(runContinueJob(row.id));
      }
    }
  }
  startReconciler() {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      void runAsSystem("local agent blocked-run recovery", () => this.reconcile())
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    };
    const timer = setInterval(tick, 30_000);
    timer.unref();
    tick();
    return () => clearInterval(timer);
  }
}
