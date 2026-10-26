import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { LocalAgentEngine, LocalAgentExecution } from "@rakazo/adapter-kit";
import { LocalAgentSessionInUseError } from "@rakazo/adapter-kit";
import type { LocalAgentDecision, LocalAgentSessionSelector } from "@rakazo/contracts";
import { LocalAgentInteractionSchema } from "@rakazo/contracts";
import { localAgentProgress } from "@rakazo/core";
import { codexExecutableIdentity, codexLocalState } from "./codex-local-state.js";
import { spawnOwnedCommand } from "./desktop-process-tree.js";
import { localAgentActivity } from "./local-agent-activity.js";
import { LocalAgentSessionPool } from "./local-agent-session-pool.js";

const exec = promisify(execFile);
const inside = (root: string, candidate: unknown) => {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return false;
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Only this reviewed protocol family is supported. Unknown releases fail closed. */
export const CODEX_LOCAL_PROTOCOL = "0.163";
export function codexLocalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "HOME",
      "PATH",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "CODEX_HOME",
    ].flatMap((key) => (source[key] ? [[key, source[key]]] : [])),
  );
}

const disabledFeatures = [
  "plugins",
  "hooks",
  "apps",
  "remote_plugin",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "multi_agent",
  "goals",
  "worktrees",
  "workspace_dependencies",
  "skill_mcp_dependency_install",
  "shell_snapshot",
];

/** CLI overrides have highest precedence, including over repository configuration. */
function filesystemPolicy(cwd: string, access: "read" | "write") {
  const filesystem: Record<string, string> = { ":minimal": "read", [cwd]: access };
  for (const name of [".git", ".agents", ".codex", ".aws"])
    filesystem[path.join(cwd, name)] = "read";
  for (const name of [".env", ".env.*", "**/.env", "**/.env.*"])
    filesystem[path.join(cwd, name)] = "deny";
  return filesystem;
}

export function codexLocalArguments(cwd: string, access: "read" | "write", profile: string) {
  const table = `{${Object.entries(filesystemPolicy(cwd, access))
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(",")}}`;
  return [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    `default_permissions=${JSON.stringify(profile)}`,
    "-c",
    `permissions.${profile}.filesystem=${table}`,
    "-c",
    `permissions.${profile}.network.enabled=false`,
    "-c",
    "mcp_servers={}",
    "-c",
    "plugins={}",
    "-c",
    "hooks={}",
    ...disabledFeatures.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "-c",
    'web_search="disabled"',
    "-c",
    'approvals_reviewer="user"',
  ];
}

type Rpc = { id?: string | number; method?: string; params?: any; result?: any; error?: unknown };
// A separate owner survives abrupt host death long enough to kill its private process group.
// stdin EOF is the ownership lease; the native server and any descendants share this group.
const SERVER_OWNER = `
const { spawn } = require('node:child_process');
const stop = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } };
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
// Native synchronous writers must not inherit Node's nonblocking output descriptors.
// Fresh child pipes and Node's forwarding streams preserve backpressure for large replies.
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
for (const output of [child.stdout, child.stderr, process.stdout, process.stderr]) output.once('error', stop);
process.stdin.pipe(child.stdin);
process.stdin.once('end', stop);
process.stdin.once('error', stop);
child.stdin.once('error', stop);
child.once('error', stop);
child.once('exit', stop);
process.once('SIGTERM', stop);
`;
function connection(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") throw new Error("Local Codex requires a reviewed POSIX host");
  const { child, tree } = spawnOwnedCommand(
    [process.execPath, "-e", SERVER_OWNER, executable, ...args],
    cwd,
    env,
  );
  const whenClosed = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let sequence = 0;
  let closed = false;
  let onMessage: (message: Rpc) => void = () => undefined;
  let onFailure: () => void = () => undefined;
  const pending = new Map<
    number,
    {
      method: string;
      threadId?: string;
      resolve: (result: any) => void;
      reject: (error: Error) => void;
    }
  >();
  const send = (value: Rpc) => {
    if (closed) throw new Error("Codex connection closed");
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const fail = () => {
    if (closed) return;
    closed = true;
    for (const request of pending.values())
      request.reject(new Error("Codex protocol connection failed"));
    pending.clear();
    onFailure();
    tree.kill();
    tree.close();
  };
  child.once("error", fail);
  child.once("exit", fail);
  child.stderr.resume(); // Never forward stderr: configuration errors can contain private values.
  let bytesSinceLine = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytesSinceLine += chunk.length;
    if (bytesSinceLine > 1_000_000) fail();
    if (chunk.includes(10)) bytesSinceLine = chunk.length - chunk.lastIndexOf(10) - 1;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim() || closed) return;
    try {
      const message = JSON.parse(line) as Rpc;
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) {
          const error = message.error as { code?: unknown; message?: unknown };
          // A generic invalid-request code alone is not a writer conflict. Match this reviewed
          // native error contract against the requested thread, then discard the private payload.
          const inUse =
            request.method === "thread/resume" &&
            request.threadId &&
            error.code === -32600 &&
            error.message === `thread ${request.threadId} already has an active writer`;
          request.reject(
            inUse ? new LocalAgentSessionInUseError() : new Error("Codex request was rejected"),
          );
        } else request.resolve(message.result);
      } else onMessage(message);
    } catch {
      fail();
    }
  });
  return {
    whenClosed,
    async idleSafe() {
      if (closed || !child.pid) return false;
      try {
        // Retaining the harness must not retain a still-running tool after its Run releases the
        // project lock. Read only PID/parent metadata; command lines can contain credentials.
        // A terminal notification can precede child exit. Recheck briefly while the Run still
        // owns its project lock; a persistent descendant must still force process-tree cleanup.
        for (let attempt = 0; attempt < 10; attempt++) {
          if (closed) return false;
          const result = await exec("/bin/ps", ["-axo", "pid=,ppid="], {
            env,
            timeout: 1_000,
            maxBuffer: 1_000_000,
          });
          const rows = result.stdout
            .trim()
            .split("\n")
            .map((line) => line.trim().split(/\s+/).map(Number));
          const descendants = new Set<number>([child.pid]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const [pid, parent] of rows)
              if (pid && parent && descendants.has(parent) && !descendants.has(pid)) {
                descendants.add(pid);
                changed = true;
              }
          }
          if (!closed && descendants.size === 2) return true;
          if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return false;
      } catch {
        return false;
      }
    },
    get isClosed() {
      return closed;
    },
    send,
    request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Codex protocol request timed out"));
        }, timeoutMs);
        timer.unref();
        pending.set(id, {
          method,
          threadId:
            params &&
            typeof params === "object" &&
            "threadId" in params &&
            typeof params.threadId === "string"
              ? params.threadId
              : undefined,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          send({ id, method, params });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error("Codex connection closed"));
        }
      });
    },
    listen(message: (value: Rpc) => void, failure: () => void) {
      onMessage = message;
      onFailure = failure;
    },
    close() {
      lines.close();
      fail();
      return whenClosed;
    },
  };
}

/** An approval can never grant more than the configured project policy. */
async function boundedApproval(
  method: string,
  params: any,
  cwd: string,
  access: "read" | "write",
  changes: any[],
) {
  // Command approval can bypass the native sandbox. v1 never grants that escape.
  // File approvals are accepted only for a previously observed, finite patch.
  if (
    method !== "item/fileChange/requestApproval" ||
    access !== "write" ||
    params.grantRoot != null ||
    changes.length === 0 ||
    changes.length > 100
  )
    return false;
  if (
    changes.some(
      (change) => !change || typeof change.path !== "string" || typeof change.diff !== "string",
    ) ||
    changes.map((change) => `${change.path}\n${change.diff}`).join("\n").length > 16_000
  )
    return false;
  for (const change of changes) {
    if (!inside(cwd, change.path)) return false;
    const relative = path.relative(cwd, change.path);
    if (
      relative
        .split(path.sep)
        .some(
          (part) =>
            [".git", ".agents", ".codex", ".aws"].includes(part) ||
            part === ".env" ||
            part.startsWith(".env."),
        )
    )
      return false;
    try {
      const resolved = await realpath(change.path).catch(() => realpath(path.dirname(change.path)));
      if (!inside(cwd, resolved)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
// Native config maps do not have a stable serialization order across requests.
const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const nativeBinding = (input: LocalAgentSessionSelector) =>
  fingerprint({ scope: input.scope, sessionId: input.sessionId, projectId: input.projectId });
type NativeSession = {
  rpc: ReturnType<typeof connection>;
  profile: string;
  configHash: string;
  accountHash: string;
  sources: string[];
  reusable: boolean;
  binding: string;
  owner: string;
  threadId?: string;
  state: string;
  close(): Promise<void>;
};

/** Validate the effective profile on both cold and warm paths, never a cached authorization. */
function verifyNativeConfig(config: any, profile: string, cwd: string, access: "read" | "write") {
  if (
    config?.web_search !== "disabled" ||
    disabledFeatures.some((feature) => config?.features?.[feature] !== false) ||
    Object.values(config?.mcp_servers ?? {}).some((entry: any) => entry?.enabled !== false)
  )
    throw new Error("Codex tool features could not be isolated");
  const permissions = config?.permissions?.[profile];
  const expected = filesystemPolicy(cwd, access);
  const filesystem = { ...permissions?.filesystem };
  if (filesystem.glob_scan_max_depth === null) delete filesystem.glob_scan_max_depth;
  if (
    permissions?.network?.enabled !== false ||
    permissions.extends != null ||
    Object.values(permissions.workspace_roots ?? {}).some(Boolean) ||
    Object.keys(filesystem).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([root, mode]) => filesystem[root] !== mode)
  )
    throw new Error("Codex project policy could not be verified");
}

function nativeConfigSources(layers: any): { sources: string[]; reusable: boolean } {
  if (!Array.isArray(layers) || layers.length > 100) return { sources: [], reusable: false };
  const sources: string[] = [];
  for (const layer of layers) {
    const name = layer?.name;
    if (name?.type === "sessionFlags") continue;
    const file =
      name?.type === "project" ? path.join(name.dotCodexFolder ?? "", "config.toml") : name?.file;
    // Cloud/MDM layers cannot be verified through filesystem identity; keep those sessions cold.
    if (typeof file !== "string" || !path.isAbsolute(file)) return { sources: [], reusable: false };
    sources.push(file);
  }
  return { sources, reusable: true };
}

export class CodexAppServerEngine implements LocalAgentEngine {
  readonly id = "codex";
  readonly supportsSessionReuse = true;
  private versionCache?: { identity: string; expires: number };
  private modelCache?: {
    key: string;
    expires: number;
    values: Array<{ id: string; label: string }>;
  };
  private modelPending?: { key: string; promise: Promise<Array<{ id: string; label: string }>> };
  private readonly connections = new Set<ReturnType<typeof connection>>();
  private closed = false;
  private readonly pool: LocalAgentSessionPool<NativeSession>;
  private readonly activeBindings = new Set<string>();
  private readonly activeSessions = new Map<string, NativeSession>();
  constructor(
    private readonly options: {
      executable: string;
      env?: NodeJS.ProcessEnv;
      rpcTimeoutMs?: number;
      onTiming?: (sample: { phase: string; durationMs: number }) => void;
      reusePolicy?: { idleTtlMs: number; maxIdleSessions: number };
    },
  ) {
    if (!path.isAbsolute(options.executable))
      throw new Error("Codex executable must be an absolute path");
    this.pool = new LocalAgentSessionPool(
      options.reusePolicy?.idleTtlMs,
      options.reusePolicy?.maxIdleSessions,
    );
  }
  private environment() {
    return codexLocalEnvironment(this.options.env ?? process.env);
  }
  async release(input: LocalAgentSessionSelector) {
    const binding = nativeBinding(input);
    const releasing = this.pool.release(binding);
    await Promise.all(
      [...this.activeSessions.values()]
        .filter((entry) => entry.binding === binding)
        .map((entry) => entry.close()),
    );
    await releasing;
  }
  async close() {
    this.closed = true;
    this.versionCache = undefined;
    this.modelCache = undefined;
    await this.pool.close();
    await Promise.all([...this.connections].map((rpc) => rpc.close()));
  }
  private async timed<T>(phase: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await work();
    } finally {
      try {
        this.options.onTiming?.({ phase, durationMs: performance.now() - start });
      } catch {
        /* Diagnostics cannot change execution or disclose the native response. */
      }
    }
  }
  private async open(cwd: string, access: "read" | "write") {
    if (this.closed) throw new Error("Local engine is closed");
    const env = this.environment();
    await this.timed("version", async () => {
      const identity = await codexExecutableIdentity(this.options.executable);
      if (this.versionCache?.identity === identity && this.versionCache.expires > performance.now())
        return;
      this.versionCache = undefined;
      const version = await exec(this.options.executable, ["--version"], {
        env,
        timeout: 5_000,
        maxBuffer: 4_096,
      });
      if (!version.stdout.startsWith(`codex-cli ${CODEX_LOCAL_PROTOCOL}.`))
        throw new Error("Unsupported Codex CLI protocol version");
      if (identity !== (await codexExecutableIdentity(this.options.executable)))
        throw new Error("Codex executable changed during verification");
      this.versionCache = { identity, expires: performance.now() + 300_000 };
    });
    if (this.closed) throw new Error("Local engine is closed");
    const profile = `rakazo_${randomUUID().replaceAll("-", "")}`;
    const args = codexLocalArguments(cwd, access, profile);
    // CLI table overrides merge across config layers. Discover ambient entries before any thread
    // exists, then explicitly disable each one and recheck the second process before execution.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.closed) throw new Error("Local engine is closed");
      const rpc = connection(this.options.executable, args, cwd, env);
      this.connections.add(rpc);
      void rpc.whenClosed.then(() => this.connections.delete(rpc));
      try {
        await this.timed("initialize", () =>
          rpc.request(
            "initialize",
            {
              clientInfo: { name: "rakazo", title: "Rakazo", version: "0.1.0" },
              capabilities: { experimentalApi: true },
            },
            this.options.rpcTimeoutMs,
          ),
        );
        rpc.send({ method: "initialized", params: {} });
        const { config, layers } = await this.timed("config", () =>
          rpc.request("config/read", { cwd, includeLayers: true }, this.options.rpcTimeoutMs),
        );
        const ambient: Array<[string, string]> = [];
        for (const key of ["mcp_servers"]) {
          for (const [name, value] of Object.entries(config?.[key] ?? {})) {
            if (
              !value ||
              typeof value !== "object" ||
              (value as { enabled?: boolean }).enabled !== false
            )
              ambient.push([key, name]);
          }
        }
        if (ambient.length) {
          if (attempt !== 0 || ambient.length > 100)
            throw new Error("Codex external tools could not be isolated");
          for (const [key, name] of ambient) {
            if (!/^[a-zA-Z0-9_-]+$/.test(name))
              throw new Error("Codex external tool name cannot be isolated");
            args.push("-c", `${key}.${name}.enabled=false`);
          }
          rpc.close();
          continue;
        }
        verifyNativeConfig(config, profile, cwd, access);
        const account = await this.timed("account", () =>
          rpc.request("account/read", { refreshToken: false }),
        );
        if (!account.account) throw new Error("Sign in to Codex locally");
        return {
          rpc,
          profile,
          configHash: fingerprint(config),
          accountHash: fingerprint(account.account),
          ...nativeConfigSources(layers),
        };
      } catch (error) {
        rpc.close();
        throw error;
      }
    }
    throw new Error("Codex external tools could not be isolated");
  }
  async models() {
    if (this.closed) throw new Error("Local engine is closed");
    const key = `${await codexExecutableIdentity(this.options.executable)}:${await codexLocalState(this.environment())}`;
    if (this.modelCache?.key === key && this.modelCache.expires > performance.now())
      return this.modelCache.values.map((value) => ({ ...value }));
    if (this.modelPending?.key === key)
      return (await this.modelPending.promise).map((value) => ({ ...value }));
    this.modelCache = undefined;
    // Every coalesced caller awaits validation, not just the caller that began discovery.
    const promise = (async () => {
      const values = await this.readModels();
      const current = `${await codexExecutableIdentity(this.options.executable)}:${await codexLocalState(this.environment())}`;
      if (this.closed || current !== key)
        throw new Error("Local engine changed during model discovery");
      this.modelCache = { key, expires: performance.now() + 30_000, values };
      return values;
    })();
    this.modelPending = { key, promise };
    try {
      return (await promise).map((value) => ({ ...value }));
    } finally {
      if (this.modelPending?.promise === promise) this.modelPending = undefined;
    }
  }
  private async readModels() {
    const { rpc } = await this.open(this.environment().HOME!, "read");
    try {
      const models: Array<{ id: string; label: string }> = [];
      let cursor: string | null = null;
      do {
        const response = await rpc.request("model/list", { cursor, limit: 100 });
        if (!Array.isArray(response.data) || models.length > 500)
          throw new Error("Invalid model catalog");
        for (const model of response.data) {
          if (typeof model.id !== "string" || typeof model.displayName !== "string")
            throw new Error("Invalid model catalog");
          models.push({ id: model.id, label: model.displayName });
        }
        cursor = response.nextCursor ?? null;
      } while (cursor);
      return models;
    } finally {
      rpc.close();
    }
  }
  private async sessionState(session: Pick<NativeSession, "sources">, cwd: string) {
    const [executable, state] = await Promise.all([
      codexExecutableIdentity(this.options.executable),
      codexLocalState(this.environment(), cwd, session.sources),
    ]);
    return `${executable}:${state}`;
  }
  private async acquire(
    input: Parameters<LocalAgentEngine["start"]>[0],
    key: string,
    binding: string,
  ) {
    let session = input.reuse ? await this.pool.take(key) : undefined;
    if (session) {
      session.owner = input.request.runId;
      try {
        if (
          session.rpc.isClosed ||
          session.threadId !== input.sessionRef ||
          session.state !== (await this.sessionState(session, input.cwd)) ||
          !(await session.rpc.idleSafe())
        )
          throw new Error("Local session state changed");
        await this.timed("warm_verify", async () => {
          const [{ config }, account, current] = await Promise.all([
            session!.rpc.request("config/read", { cwd: input.cwd, includeLayers: false }),
            session!.rpc.request("account/read", { refreshToken: false }),
            session!.rpc.request("thread/read", {
              threadId: session!.threadId,
              includeTurns: false,
            }),
          ]);
          verifyNativeConfig(config, session!.profile, input.cwd, input.request.access);
          if (
            fingerprint(config) !== session!.configHash ||
            !account.account ||
            fingerprint(account.account) !== session!.accountHash ||
            current.thread?.id !== session!.threadId ||
            current.thread.cwd !== input.cwd ||
            current.thread.model !== input.request.model ||
            current.thread.status?.type !== "idle"
          )
            throw new Error("Local session policy changed");
        });
        return { session, warm: true };
      } catch {
        // Nothing has been submitted; discarding an unprovable idle session is a safe cold fallback.
        await session.close();
        session = undefined;
      }
    }
    const opened = await this.open(input.cwd, input.request.access);
    try {
      const state = await this.sessionState(opened, input.cwd);
      const native: NativeSession = {
        ...opened,
        binding,
        owner: input.request.runId,
        state,
        close: () => opened.rpc.close(),
      };
      return { session: native, warm: false };
    } catch (error) {
      await opened.rpc.close();
      throw error;
    }
  }
  async start(input: Parameters<LocalAgentEngine["start"]>[0]): Promise<LocalAgentExecution> {
    const began = performance.now();
    const recordTiming = (phase: string) => {
      try {
        this.options.onTiming?.({ phase, durationMs: performance.now() - began });
      } catch {
        /* Timing is optional diagnostic metadata, never part of task success. */
      }
    };
    await input.emit({ type: "activity", text: localAgentProgress.connecting });
    recordTiming("first_feedback");
    const binding = nativeBinding(input.request);
    const key = fingerprint([
      binding,
      input.cwd,
      input.request.model,
      input.request.access,
      input.request.instructions,
    ]);
    if (this.activeBindings.has(key)) throw new Error("Local session is busy");
    this.activeBindings.add(key);
    const generation = this.pool.generation(binding);
    let acquired: Awaited<ReturnType<CodexAppServerEngine["acquire"]>>;
    try {
      acquired = await this.acquire(input, key, binding);
    } catch (error) {
      this.activeBindings.delete(key);
      throw error;
    }
    const native = acquired.session;
    this.activeSessions.set(key, native);
    const { rpc, profile } = native;
    recordTiming(acquired.warm ? "warm_ready" : "cold_ready");
    const activity = localAgentActivity(input.emit);
    let threadId = native.threadId;
    let turnId: string | undefined;
    let settled = false;
    let stopping = false;
    let firstEvent = true;
    let firstText = true;
    let cleanup: Promise<unknown> = Promise.resolve();
    let retain = input.reuse === true && native.reusable;
    let resolve!: (result: "completed" | "cancelled") => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<"completed" | "cancelled">((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    // Setup can fail before returning the handle; suppress unhandled rejection without masking it.
    void completion.catch(() => undefined);
    let events: Promise<void> = Promise.resolve();
    const pending = new Map<string, { rpcId: string | number; method: string; params: any }>();
    const fileChanges = new Map<string, any[]>();
    const finish = (status?: "completed" | "cancelled") => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      cleanup = (async () => {
        try {
          await activity.close();
          // A released or changed binding can never re-enter the idle cache after completion.
          if (
            status === "completed" &&
            retain &&
            !pending.size &&
            !this.closed &&
            !rpc.isClosed &&
            generation === this.pool.generation(binding) &&
            native.state === (await this.sessionState(native, input.cwd)) &&
            (await rpc.idleSafe())
          ) {
            rpc.listen(
              (message) => {
                if (message.id !== undefined && message.method) void rpc.close();
              },
              () => undefined,
            );
            await this.pool.put(key, binding, generation, native);
          } else await rpc.close();
        } catch (error) {
          await rpc.close();
          throw error;
        } finally {
          this.activeBindings.delete(key);
          if (this.activeSessions.get(key) === native) this.activeSessions.delete(key);
        }
      })();
      recordTiming("total");
      void cleanup.then(
        () => {
          if (status) resolve(status);
          else reject(new Error("Codex turn did not complete"));
        },
        () => reject(new Error("Codex progress could not be saved")),
      );
    };
    const abort = () => {
      stopping = true;
      finish("cancelled");
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    const handle = async (message: Rpc) => {
      const p = message.params ?? {};
      if (message.id !== undefined && message.method) {
        if (p.threadId !== threadId || (turnId && p.turnId !== turnId)) {
          rpc.send({ id: message.id, error: { code: -32602, message: "Unbound request" } });
          return;
        }
        const question = message.method === "item/tool/requestUserInput";
        const permitted = await boundedApproval(
          message.method,
          p,
          input.cwd,
          input.request.access,
          fileChanges.get(p.itemId) ?? [],
        );
        if (!question && !permitted) {
          if (message.method === "item/permissions/requestApproval")
            rpc.send({ id: message.id, result: { permissions: {}, scope: "turn" } });
          else if (message.method.endsWith("/requestApproval"))
            rpc.send({ id: message.id, result: { decision: "decline" } });
          else
            rpc.send({ id: message.id, error: { code: -32601, message: "Unsupported request" } });
          return;
        }
        if (
          pending.size ||
          (question &&
            (!p.isBlocking ||
              !Array.isArray(p.questions) ||
              p.questions.some((item: any) => item.isSecret)))
        )
          throw new Error("Unsupported Codex interaction");
        const interaction = LocalAgentInteractionSchema.parse({
          id: randomUUID(),
          kind: question ? "question" : "approval",
          summary: question
            ? p.questions.map((item: any) => item.question).join("\n")
            : (p.command ?? p.reason ?? "Review local file changes"),
          detail: question
            ? undefined
            : (fileChanges.get(p.itemId) ?? [])
                .map((change) => `${change.path}\n${change.diff ?? ""}`)
                .join("\n")
                .slice(0, 16_000),
          questions: question
            ? p.questions.map((item: any) => ({
                id: item.id,
                question: item.question,
                options: item.options?.map((option: any) => option.label),
              }))
            : undefined,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        pending.set(interaction.id, { rpcId: message.id, method: message.method, params: p });
        await activity.barrier();
        await input.emit({ type: "interaction", interaction });
        return;
      }
      const connectionError = message.method === "error" && !p.threadId && !p.turnId;
      if (!connectionError && p.threadId !== threadId) return;
      if (message.method === "turn/started") {
        if (turnId && p.turn?.id !== turnId) return;
        turnId = p.turn?.id;
      }
      if (p.turnId && turnId && p.turnId !== turnId) return;
      if (firstEvent) {
        firstEvent = false;
        recordTiming("first_native_event");
      }
      if (message.method === "item/reasoning/summaryTextDelta" && typeof p.delta === "string")
        activity.summary(`${p.itemId}:${p.summaryIndex}`, p.delta);
      if (message.method === "item/started" && p.item?.type === "reasoning")
        await activity.phase(localAgentProgress.thinking);
      if (
        message.method === "item/started" &&
        p.item?.type === "fileChange" &&
        Array.isArray(p.item.changes)
      )
        fileChanges.set(p.item.id, p.item.changes);
      if (message.method === "item/agentMessage/delta" && typeof p.delta === "string") {
        if (firstText && p.delta.trim()) {
          firstText = false;
          recordTiming("first_text");
        }
        await activity.barrier();
        await input.emit({ type: "text", text: p.delta });
      }
      if (
        message.method === "item/started" &&
        ["commandExecution", "fileChange"].includes(p.item?.type)
      )
        await activity.phase(p.item.command ?? "Local file changes");
      if (message.method === "turn/completed" && p.turn?.id === turnId)
        finish(
          p.turn.status === "completed"
            ? "completed"
            : p.turn.status === "interrupted"
              ? "cancelled"
              : undefined,
        );
      if (message.method === "error") {
        if (p.willRetry === true) {
          recordTiming("retry");
          const info = p.error?.codexErrorInfo;
          const limited =
            info === "rateLimitExceeded" ||
            [
              "httpConnectionFailed",
              "responseStreamConnectionFailed",
              "responseStreamDisconnected",
              "responseTooManyFailedAttempts",
            ].some((key) => info?.[key]?.httpStatusCode === 429);
          await activity.phase(limited ? localAgentProgress.limited : localAgentProgress.retrying);
        } else finish();
      }
    };
    let starting = true;
    const early: Rpc[] = [];
    let earlyBytes = 0;
    const enqueue = (message: Rpc) => {
      events = events.then(() => (settled ? undefined : handle(message))).catch(() => finish());
    };
    rpc.listen(
      (message) => {
        if (starting) {
          earlyBytes += Buffer.byteLength(JSON.stringify(message));
          if (early.length >= 512 || earlyBytes > 1_000_000) return finish();
          early.push(message);
        } else enqueue(message);
      },
      () => finish(stopping ? "cancelled" : undefined),
    );
    try {
      input.signal?.throwIfAborted();
      const selection = {
        cwd: input.cwd,
        model: input.request.model,
        permissions: profile,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        developerInstructions: input.request.instructions,
      };
      if (!acquired.warm) {
        if (input.sessionRef) await activity.phase(localAgentProgress.restoring);
        const started = await this.timed(input.sessionRef ? "resume" : "thread", () =>
          rpc.request(input.sessionRef ? "thread/resume" : "thread/start", {
            ...selection,
            // Rakazo already persists visible events; hydrate only native metadata on resume.
            ...(input.sessionRef
              ? { threadId: input.sessionRef, excludeTurns: true }
              : { ephemeral: false }),
          }),
        );
        if (
          started.activePermissionProfile?.id !== profile ||
          started.cwd !== input.cwd ||
          !Array.isArray(started.runtimeWorkspaceRoots) ||
          started.runtimeWorkspaceRoots.length !== 1 ||
          started.runtimeWorkspaceRoots[0] !== input.cwd ||
          started.approvalPolicy !== "on-request" ||
          started.approvalsReviewer !== "user" ||
          typeof started.thread?.id !== "string"
        )
          throw new Error("Codex resolved policy mismatch");
        threadId = started.thread.id;
        native.threadId = threadId;
        if (native.state !== (await this.sessionState(native, input.cwd)))
          throw new Error("Local state changed during thread setup");
        const sources = started.instructionSources;
        if (
          !Array.isArray(sources) ||
          sources.length > 100 ||
          sources.some((file: unknown) => typeof file !== "string" || !path.isAbsolute(file))
        )
          retain = false;
        else native.sources = [...new Set([...native.sources, ...sources])];
        native.state = await this.sessionState(native, input.cwd);
      }
      await input.session(threadId!);
      input.signal?.throwIfAborted();
      if (
        this.closed ||
        generation !== this.pool.generation(binding) ||
        rpc.isClosed ||
        native.state !== (await this.sessionState(native, input.cwd))
      )
        throw new Error("Local session changed before submission");
      const turn = await this.timed("submit", () =>
        rpc.request("turn/start", {
          threadId,
          model: input.request.model,
          cwd: input.cwd,
          runtimeWorkspaceRoots: [input.cwd],
          input: [{ type: "text", text: input.request.prompt }],
          clientUserMessageId: input.request.runId,
          permissions: profile,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          summary: "concise",
        }),
      );
      if (typeof turn.turn?.id !== "string") throw new Error("Invalid native turn");
      turnId = turn.turn.id;
      if (!settled) await activity.phase(localAgentProgress.waiting);
      starting = false;
      for (const message of early.splice(0)) enqueue(message);
    } catch (error) {
      finish();
      // The Host releases its project lock when start rejects. Finish native cleanup first so
      // a new explicit run cannot race the previous admission attempt or its process tree.
      await cleanup;
      throw error;
    }
    return {
      completion,
      async respond(id: string, decision: LocalAgentDecision) {
        const request = pending.get(id);
        if (!request || settled) throw new Error("Codex request expired");
        let result: unknown = { decision: decision.decision === "allow" ? "accept" : "decline" };
        if (request.method === "item/tool/requestUserInput") {
          const questions = request.params.questions as Array<{ id: string }>;
          if (
            decision.decision === "answer" &&
            questions.some((question) => !decision.answers?.[question.id])
          )
            throw new Error("Incomplete question response");
          result = {
            answers: Object.fromEntries(
              questions.map((question) => [
                question.id,
                { answers: decision.decision === "answer" ? [decision.answers![question.id]] : [] },
              ]),
            ),
          };
        }
        rpc.send({ id: request.rpcId, result });
        pending.delete(id);
      },
      cancel: async () => {
        if (settled) {
          retain = false;
          await cleanup;
          if (native.owner === input.request.runId) await native.close();
          return;
        }
        stopping = true;
        try {
          await rpc.request("turn/interrupt", { threadId, turnId }, 750);
        } catch {
          /* The owned process group is the bounded fallback. */
        }
        finish("cancelled");
        await cleanup;
      },
    };
  }
}
