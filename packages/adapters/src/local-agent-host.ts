import { createHash, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import type { LocalAgentEngine, LocalAgentExecution } from "@rakazo/adapter-kit";
import type {
  LocalAgentDecision,
  LocalAgentEnvelope,
  LocalAgentRelease,
  LocalAgentStart,
} from "@rakazo/contracts";
import {
  LocalAgentCancelSchema,
  LocalAgentDecisionSchema,
  LocalAgentEnvelopeSchema,
  LocalAgentReleaseSchema,
  LocalAgentStartSchema,
} from "@rakazo/contracts";
import { localAgentProgress } from "@rakazo/core";

export interface LocalAgentHostOptions {
  root: string;
  token: string;
  projects: Array<{ id: string; label: string; root: string; access: "read" | "write" }>;
  bindings: Array<{ spaceId: string; userId: string; botId: string; projects: string[] }>;
  engine: LocalAgentEngine;
  hostname?: string;
  allowedHosts?: string[];
  port?: number;
  leaseMs?: number;
  maxRuns?: number;
  maxEventBytes?: number;
  sessionReuse?: boolean;
}

type RunRecord = {
  request: LocalAgentStart;
  hash: string;
  status:
    | "starting"
    | "running"
    | "waiting_input"
    | "completed"
    | "failed"
    | "cancelled"
    | "uncertain";
  events: LocalAgentEnvelope[];
  decisions: Record<string, LocalAgentDecision>;
  expires: number;
  reuse?: boolean;
};
type ReleaseRecord = { request: LocalAgentRelease; runIds: string[]; complete: boolean };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = (record: RunRecord) =>
  ["completed", "failed", "cancelled", "uncertain"].includes(record.status);
const sessionKey = (request: LocalAgentStart) =>
  digest({
    scope: request.scope,
    sessionId: request.sessionId,
    projectId: request.projectId,
    model: request.model,
    access: request.access,
  });

/** Refuse symlinks and files readable by another account before parsing private configuration. */
export async function readLocalAgentPrivateFile(file: string): Promise<unknown> {
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("Local agent file must be private and owned by this account");
  }
  return JSON.parse(await readFile(file, "utf8"));
}

async function privateWrite(file: string, value: unknown) {
  const temp = `${file}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function body(request: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256_000) throw new HostError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HostError(400, "Invalid request");
  }
}

/** Authenticated, bounded host control plane. Raw engine RPC and paths never cross this boundary. */
export async function startLocalAgentHost(options: LocalAgentHostOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error("Invalid local agent credential");
  if (!path.isAbsolute(options.root)) throw new Error("Local agent state needs an absolute path");
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(options.root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await realpath(options.root)) !== path.resolve(options.root) ||
    (rootStat.mode & 0o077) !== 0 ||
    (process.getuid && rootStat.uid !== process.getuid())
  )
    throw new Error("Local agent directory must be private");
  const projects = new Map<string, LocalAgentHostOptions["projects"][number]>();
  for (const project of options.projects) {
    if (
      projects.has(project.id) ||
      !path.isAbsolute(project.root) ||
      (await realpath(project.root)) !== path.resolve(project.root) ||
      !(await lstat(project.root)).isDirectory()
    )
      throw new Error("Invalid local project");
    const relative = path.relative(project.root, path.resolve(options.root));
    if (!relative.startsWith("..") && !path.isAbsolute(relative))
      throw new Error("Local agent state must be outside project roots");
    projects.set(project.id, { ...project, root: path.resolve(project.root) });
  }
  const runs = new Map<string, RunRecord>();
  const executions = new Map<string, LocalAgentExecution>();
  const launching = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const cancellations = new Map<
    string,
    { scope: LocalAgentStart["scope"]; runId: string; projectId: string }
  >();
  const launches = new Set<Promise<void>>();
  const launchTasks = new Map<string, Promise<void>>();
  const released = new Map<string, ReleaseRecord>();
  const releaseTasks = new Map<string, Promise<void>>();
  const bindingKey = (request: Pick<LocalAgentStart, "scope" | "sessionId" | "projectId">) =>
    digest({ scope: request.scope, sessionId: request.sessionId, projectId: request.projectId });
  const isReleasing = (key: string) =>
    [...released.values()].some((value) => !value.complete && bindingKey(value.request) === key);
  const lifecycle = () => ({
    sessionRelease: typeof options.engine.release === "function",
    sessionReuse:
      options.sessionReuse === true &&
      options.engine.supportsSessionReuse === true &&
      typeof options.engine.release === "function",
  });
  let closed = false;
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const fileOf = (id: string) => path.join(options.root, `run-${digest(id)}.json`);
  let queue: Promise<unknown> = Promise.resolve();
  // Serialize journal mutations, including lease fences and approval CAS, without blocking model work.
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const save = (record: RunRecord) => privateWrite(fileOf(record.request.runId), record);
  const authorized = (request: Pick<LocalAgentStart, "scope" | "projectId">) =>
    options.bindings.some(
      (binding) =>
        binding.spaceId === request.scope.spaceId &&
        binding.userId === request.scope.userId &&
        binding.botId === request.scope.botId &&
        binding.projects.includes(request.projectId),
    );
  const interactionOf = (record: RunRecord) => {
    if (record.status !== "waiting_input") return null;
    const last = [...record.events].reverse().find((item) => item.event.type === "interaction");
    return last?.event.type === "interaction" ? last.event.interaction : null;
  };
  const statusOf = (record: RunRecord) => ({
    runId: record.request.runId,
    status: record.status,
    sequence: record.events.length,
    interaction: interactionOf(record),
  });
  const append = async (record: RunRecord, event: LocalAgentEnvelope["event"]) => {
    if (terminal(record)) return;
    const last = record.events.at(-1)?.event;
    if (event.type === "activity" && last?.type === "activity" && last.text === event.text) return;
    if (
      Buffer.byteLength(JSON.stringify(record.events)) + Buffer.byteLength(JSON.stringify(event)) >
      (options.maxEventBytes ?? 4_000_000)
    ) {
      event = { type: "terminal", status: "failed", error: "Local agent event capacity exceeded" };
      void executions
        .get(record.request.runId)
        ?.cancel()
        .catch(() => undefined);
    }
    const envelope = LocalAgentEnvelopeSchema.parse({ sequence: record.events.length + 1, event });
    record.events.push(envelope);
    if (event.type === "interaction") {
      record.status = "waiting_input";
      record.expires = Date.parse(event.interaction.expiresAt);
    }
    if (event.type === "resolved") {
      record.status = "running";
      record.expires = Date.now() + (options.leaseMs ?? 90_000);
    }
    if (event.type === "terminal") record.status = event.status;
    await save(record);
    bus.emit(record.request.runId);
  };
  // A process cannot survive a host restart with a trustworthy pending RPC request.
  for (const name of await readdir(options.root)) {
    if (/^released-[a-f0-9]{64}\.json$/.test(name)) {
      const value = (await readLocalAgentPrivateFile(
        path.join(options.root, name),
      )) as ReleaseRecord;
      value.request = LocalAgentReleaseSchema.parse(value.request);
      if (
        !Array.isArray(value.runIds) ||
        value.runIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id)) ||
        typeof value.complete !== "boolean"
      )
        throw new Error("Invalid session release journal");
      if (name !== `released-${digest(value.request.idempotencyKey)}.json`)
        throw new Error("Invalid session release journal");
      released.set(value.request.idempotencyKey, value);
      continue;
    }
    if (/^cancel-[a-f0-9]{64}\.json$/.test(name)) {
      const cancellation = LocalAgentCancelSchema.parse(
        await readLocalAgentPrivateFile(path.join(options.root, name)),
      );
      cancellations.set(cancellation.runId, cancellation);
      continue;
    }
    if (!/^run-[a-f0-9]{64}\.json$/.test(name)) continue;
    const value = (await readLocalAgentPrivateFile(path.join(options.root, name))) as RunRecord;
    value.request = LocalAgentStartSchema.parse(value.request);
    value.events = value.events.map((event) => LocalAgentEnvelopeSchema.parse(event));
    if (name !== path.basename(fileOf(value.request.runId))) throw new Error("Invalid run journal");
    runs.set(value.request.runId, value);
    if (!terminal(value))
      await append(value, {
        type: "terminal",
        status: "uncertain",
        error: "Local agent restarted; execution was not replayed",
      });
  }

  const launch = async (record: RunRecord) => {
    const id = record.request.runId;
    launching.add(id);
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      // Persist feedback before any engine setup can block on local or remote discovery.
      await exclusive(() =>
        append(record, { type: "activity", text: localAgentProgress.connecting }),
      );
      const project = projects.get(record.request.projectId)!;
      // Re-resolve immediately before execution, rejecting a replaced project symlink.
      if ((await realpath(project.root)) !== project.root)
        throw new Error("Project directory changed");
      if (cancellations.has(id)) throw new Error("Local run was released");
      const sessionFile = path.join(options.root, `session-${sessionKey(record.request)}.json`);
      let sessionRef: string | undefined;
      try {
        sessionRef = ((await readLocalAgentPrivateFile(sessionFile)) as { reference: string })
          .reference;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const execution = await options.engine.start({
        request: record.request,
        cwd: project.root,
        sessionRef,
        reuse: record.reuse === true && lifecycle().sessionReuse,
        signal: controller.signal,
        session: (reference) => privateWrite(sessionFile, { reference }),
        emit: (event) => exclusive(() => append(record, event)),
      });
      executions.set(id, execution);
      if (terminal(record)) await execution.cancel();
      else if (record.status === "starting") {
        record.status = "running";
        await exclusive(() => save(record));
      }
      const result = await execution.completion;
      await exclusive(() => append(record, { type: "terminal", status: result }));
    } catch {
      await exclusive(() =>
        append(record, {
          type: "terminal",
          status: controller.signal.aborted ? "cancelled" : "failed",
          error: "Local agent execution failed; check local engine configuration",
        }),
      );
    } finally {
      launching.delete(id);
      controllers.delete(id);
      executions.delete(id);
    }
  };

  const secret = Buffer.from(`Bearer ${options.token}`);
  let streams = 0;
  const server = createServer(async (request, response) => {
    const credential = Buffer.from(request.headers.authorization ?? "");
    if (
      request.headers.origin ||
      credential.length !== secret.length ||
      !timingSafeEqual(credential, secret)
    ) {
      response.writeHead(401).end();
      return;
    }
    // DNS rebinding cannot select an arbitrary Host; direct callers must use the listener authority.
    const host = request.headers.host;
    const allowedHosts = options.allowedHosts ?? ["127.0.0.1", "localhost", "[::1]"];
    if (!host || !allowedHosts.includes(host.replace(/:\d+$/, ""))) {
      response.writeHead(400).end();
      return;
    }
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? "/", "http://local.invalid");
      if (request.method === "GET" && url.pathname === "/v1/lifecycle") {
        json(lifecycle());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions/release") {
        const parsed = LocalAgentReleaseSchema.safeParse(await body(request));
        if (!parsed.success || !authorized(parsed.data))
          throw new HostError(403, "Session release is not authorized");
        if (!options.engine.release) throw new HostError(404, "Session release is unavailable");
        const input = parsed.data;
        const key = bindingKey(input);
        const operation = await exclusive(async () => {
          if (
            [...runs.values()].some(
              (record) =>
                record.request.sessionId === input.sessionId && bindingKey(record.request) !== key,
            )
          )
            throw new HostError(403, "Session release binding changed");
          const previous = released.get(input.idempotencyKey);
          if (previous) {
            if (bindingKey(previous.request) !== key)
              throw new HostError(409, "Session release operation changed");
            return previous;
          }
          if (isReleasing(key)) throw new HostError(423, "Local session release is pending");
          if (released.size >= (options.maxRuns ?? 128))
            throw new HostError(429, "Session release capacity reached");
          const runIds = [...runs.values()]
            .filter((record) => !terminal(record) && bindingKey(record.request) === key)
            .map((record) => record.request.runId);
          if (
            cancellations.size + runIds.filter((id) => !cancellations.has(id)).length >
            (options.maxRuns ?? 128)
          )
            throw new HostError(429, "Cancellation capacity reached");
          const next: ReleaseRecord = { request: input, runIds, complete: false };
          // The immutable receipt fences old runs without disabling later explicit user turns.
          await privateWrite(
            path.join(options.root, `released-${digest(input.idempotencyKey)}.json`),
            next,
          );
          released.set(input.idempotencyKey, next);
          return next;
        });
        if (!operation.complete) {
          let task = releaseTasks.get(input.idempotencyKey);
          if (!task) {
            task = (async () => {
              await exclusive(async () => {
                for (const id of operation.runIds) {
                  const cancellation = {
                    scope: input.scope,
                    runId: id,
                    projectId: input.projectId,
                  };
                  await privateWrite(
                    path.join(options.root, `cancel-${digest(id)}.json`),
                    cancellation,
                  );
                  cancellations.set(id, cancellation);
                  controllers.get(id)?.abort();
                }
              });
              await Promise.all(operation.runIds.map((id) => executions.get(id)?.cancel()));
              await Promise.all(operation.runIds.map((id) => launchTasks.get(id)));
              await options.engine.release!(input);
              await exclusive(async () => {
                await privateWrite(
                  path.join(options.root, `released-${digest(input.idempotencyKey)}.json`),
                  { ...operation, complete: true },
                );
                operation.complete = true;
              });
            })();
            releaseTasks.set(input.idempotencyKey, task);
            void task
              .finally(() => releaseTasks.delete(input.idempotencyKey))
              .catch(() => undefined);
          }
          await task;
        }
        json({ released: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/cancellations") {
        const parsed = LocalAgentCancelSchema.safeParse(await body(request));
        if (!parsed.success || !authorized(parsed.data))
          throw new HostError(403, "Cancellation is not authorized");
        const cancellation = parsed.data;
        const record = await exclusive(async () => {
          const record = runs.get(cancellation.runId);
          if (
            record &&
            (JSON.stringify(record.request.scope) !== JSON.stringify(cancellation.scope) ||
              record.request.projectId !== cancellation.projectId)
          )
            throw new HostError(403, "Cancellation binding changed");
          if (
            cancellations.size >= (options.maxRuns ?? 128) &&
            !cancellations.has(cancellation.runId)
          )
            throw new HostError(429, "Cancellation capacity reached");
          await privateWrite(
            path.join(options.root, `cancel-${digest(cancellation.runId)}.json`),
            cancellation,
          );
          cancellations.set(cancellation.runId, cancellation);
          controllers.get(cancellation.runId)?.abort();
          if (record) await append(record, { type: "terminal", status: "cancelled" });
          return record;
        });
        await executions.get(cancellation.runId)?.cancel();
        json(
          record
            ? statusOf(record)
            : { runId: cancellation.runId, status: "cancelled", sequence: 0, interaction: null },
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        json({
          protocol: 1,
          engine: options.engine.id,
          projects: options.projects
            .filter((project) =>
              options.bindings.some((binding) => binding.projects.includes(project.id)),
            )
            .map(({ id, label, access }) => ({ id, label, access })),
          models: await options.engine.models(),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const parsed = LocalAgentStartSchema.safeParse(await body(request));
        if (!parsed.success) throw new HostError(400, "Invalid run");
        const input = parsed.data;
        const project = projects.get(input.projectId);
        if (
          !project ||
          !authorized(input) ||
          (input.access === "write" && project.access !== "write")
        )
          throw new HostError(403, "Local project is not authorized");
        const { fence: _fence, ...content } = input;
        const hash = digest(content);
        const record = await exclusive(async () => {
          const previous = runs.get(input.runId);
          if (previous) {
            if (previous.hash !== hash || input.fence < previous.request.fence)
              throw new HostError(409, "Run binding or fence changed");
            previous.request.fence = input.fence;
            if (!terminal(previous) && previous.status !== "waiting_input")
              previous.expires = Date.now() + (options.leaseMs ?? 90_000);
            await save(previous);
            return previous;
          }
          if (isReleasing(bindingKey(input)))
            throw new HostError(423, "Local session release is pending");
          if (runs.size >= (options.maxRuns ?? 128))
            throw new HostError(429, "Local run capacity reached");
          if (
            [...runs.values()].some(
              (other) =>
                !terminal(other) &&
                (sessionKey(other.request) === sessionKey(input) ||
                  (other.request.projectId === input.projectId &&
                    (other.request.access === "write" || input.access === "write"))),
            )
          )
            throw new HostError(423, "Local session or project is busy");
          const next: RunRecord = {
            request: input,
            hash,
            status: "starting",
            events: [],
            decisions: {},
            expires: Date.now() + (options.leaseMs ?? 90_000),
            reuse: request.headers["rakazo-session-reuse"] === "1" && lifecycle().sessionReuse,
          };
          const cancelled = cancellations.get(input.runId);
          if (cancelled) {
            if (
              JSON.stringify(cancelled.scope) !== JSON.stringify(input.scope) ||
              cancelled.projectId !== input.projectId
            )
              throw new HostError(403, "Cancellation binding changed");
            next.status = "cancelled";
            next.events = [{ sequence: 1, event: { type: "terminal", status: "cancelled" } }];
          }
          await save(next);
          runs.set(input.runId, next);
          return next;
        });
        if (closed) throw new HostError(503, "Local agent is shutting down");
        if (record.status === "starting" && !launching.has(input.runId)) {
          const task = launch(record);
          launches.add(task);
          launchTasks.set(input.runId, task);
          void task
            .finally(() => {
              launches.delete(task);
              launchTasks.delete(input.runId);
            })
            .catch(() => undefined);
        }
        json(statusOf(record));
        return;
      }
      const match =
        /^\/v1\/runs\/([a-zA-Z0-9:_-]+)(?:\/(events|heartbeat|cancel|interactions)(?:\/([a-zA-Z0-9:_-]+))?)?$/.exec(
          url.pathname,
        );
      const record = match ? runs.get(match[1]!) : undefined;
      if (!match || !record || !authorized(record.request))
        throw new HostError(404, "Run not found");
      if (request.method === "GET" && !match[2]) {
        json(statusOf(record));
        return;
      }
      if (request.method === "GET" && match[2] === "events") {
        let after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(after) || after < 0 || after > record.events.length)
          throw new HostError(409, "Event cursor is invalid");
        if (streams >= 16) throw new HostError(429, "Too many event consumers");
        streams++;
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        });
        const flush = () => {
          for (const event of record.events.slice(after)) {
            response.write(`${JSON.stringify(event)}\n`);
            after = event.sequence;
          }
          if (terminal(record) || record.status === "waiting_input") response.end();
        };
        const heartbeat = setInterval(() => response.write("\n"), 15_000);
        heartbeat.unref();
        bus.on(record.request.runId, flush);
        response.once("close", () => {
          streams--;
          clearInterval(heartbeat);
          bus.off(record.request.runId, flush);
        });
        flush();
        return;
      }
      if (request.method !== "POST") throw new HostError(404, "Unknown operation");
      const raw = await body(request);
      if (!raw || !Number.isSafeInteger(raw.fence) || raw.fence !== record.request.fence)
        throw new HostError(409, "Execution fence expired");
      if (match[2] === "heartbeat") {
        await exclusive(async () => {
          if (!terminal(record) && record.status !== "waiting_input") {
            record.expires = Date.now() + (options.leaseMs ?? 90_000);
            await save(record);
          }
        });
      } else if (match[2] === "cancel") {
        controllers.get(record.request.runId)?.abort();
        await executions.get(record.request.runId)?.cancel();
        await exclusive(() => append(record, { type: "terminal", status: "cancelled" }));
      } else if (match[2] === "interactions" && match[3]) {
        const decision = LocalAgentDecisionSchema.safeParse(raw);
        if (!decision.success) throw new HostError(400, "Invalid decision");
        const interactionId = match[3];
        await exclusive(async () => {
          const previous = record.decisions[interactionId];
          if (previous) {
            if (
              previous.decision !== decision.data.decision ||
              JSON.stringify(previous.answers) !== JSON.stringify(decision.data.answers)
            )
              throw new HostError(409, "Decision already recorded");
            return;
          }
          const pending = interactionOf(record);
          if (
            !pending ||
            pending.id !== interactionId ||
            Date.parse(pending.expiresAt) <= Date.now() ||
            !executions.has(record.request.runId)
          )
            throw new HostError(409, "Interaction expired");
          if (
            (pending.kind === "approval" && decision.data.decision === "answer") ||
            (pending.kind === "question" && decision.data.decision === "allow")
          )
            throw new HostError(400, "Invalid interaction response");
          record.decisions[interactionId] = decision.data;
          await save(record);
          try {
            await executions.get(record.request.runId)!.respond(interactionId, decision.data);
          } catch {
            await append(record, {
              type: "terminal",
              status: "uncertain",
              error: "Native response delivery is uncertain",
            });
            void executions
              .get(record.request.runId)
              ?.cancel()
              .catch(() => undefined);
            throw new HostError(409, "Native response delivery is uncertain");
          }
          await append(record, { type: "resolved", interactionId });
        });
      } else throw new HostError(404, "Unknown operation");
      json(statusOf(record));
    } catch (error) {
      if (!response.headersSent)
        json(
          { error: error instanceof HostError ? error.message : "Local agent request failed" },
          error instanceof HostError ? error.status : 500,
        );
      else response.destroy();
    }
  });
  const watchdog = setInterval(
    () => {
      for (const record of runs.values())
        if (!terminal(record) && record.expires < Date.now()) {
          void executions
            .get(record.request.runId)
            ?.cancel()
            .catch(() => undefined);
          void exclusive(() =>
            append(record, {
              type: "terminal",
              status: "cancelled",
              error: "Local execution lease or interaction expired",
            }),
          );
        }
    },
    Math.min(options.leaseMs ?? 90_000, 1_000),
  );
  watchdog.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    async close() {
      closed = true;
      for (const controller of controllers.values()) controller.abort();
      clearInterval(watchdog);
      await exclusive(async () => {
        for (const record of runs.values())
          await append(record, { type: "terminal", status: "cancelled" });
      });
      await Promise.allSettled([...executions.values()].map((execution) => execution.cancel()));
      await Promise.allSettled([...launches]);
      await Promise.allSettled([...releaseTasks.values()]);
      await options.engine.close?.();
      await queue;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
