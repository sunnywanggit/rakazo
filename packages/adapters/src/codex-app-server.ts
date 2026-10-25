import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { LocalAgentEngine, LocalAgentExecution } from "@rakazo/adapter-kit";
import type { LocalAgentDecision } from "@rakazo/contracts";
import { LocalAgentInteractionSchema } from "@rakazo/contracts";
import { spawnOwnedCommand } from "./desktop-process-tree.js";

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
function connection(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const { child, tree } = spawnOwnedCommand([executable, ...args], cwd, env);
  let sequence = 0;
  let closed = false;
  let onMessage: (message: Rpc) => void = () => undefined;
  let onFailure: () => void = () => undefined;
  const pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
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
        if (message.error) request.reject(new Error("Codex request was rejected"));
        else request.resolve(message.result);
      } else onMessage(message);
    } catch {
      fail();
    }
  });
  return {
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

export class CodexAppServerEngine implements LocalAgentEngine {
  readonly id = "codex";
  constructor(
    private readonly options: {
      executable: string;
      env?: NodeJS.ProcessEnv;
      rpcTimeoutMs?: number;
    },
  ) {
    if (!path.isAbsolute(options.executable))
      throw new Error("Codex executable must be an absolute path");
  }
  private environment() {
    return codexLocalEnvironment(this.options.env ?? process.env);
  }
  private async open(cwd: string, access: "read" | "write") {
    const env = this.environment();
    const version = await exec(this.options.executable, ["--version"], {
      env,
      timeout: 5_000,
      maxBuffer: 4_096,
    });
    if (!version.stdout.startsWith(`codex-cli ${CODEX_LOCAL_PROTOCOL}.`))
      throw new Error("Unsupported Codex CLI protocol version");
    const profile = `rakazo_${randomUUID().replaceAll("-", "")}`;
    const args = codexLocalArguments(cwd, access, profile);
    // CLI table overrides merge across config layers. Discover ambient entries before any thread
    // exists, then explicitly disable each one and recheck the second process before execution.
    for (let attempt = 0; attempt < 2; attempt++) {
      const rpc = connection(this.options.executable, args, cwd, env);
      try {
        await rpc.request(
          "initialize",
          {
            clientInfo: { name: "rakazo", title: "Rakazo", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          },
          this.options.rpcTimeoutMs,
        );
        rpc.send({ method: "initialized", params: {} });
        const { config } = await rpc.request(
          "config/read",
          { cwd, includeLayers: false },
          this.options.rpcTimeoutMs,
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
        if (disabledFeatures.some((feature) => config?.features?.[feature] !== false))
          throw new Error("Codex tool features could not be isolated");
        const account = await rpc.request("account/read", { refreshToken: false });
        if (!account.account) throw new Error("Sign in to Codex locally");
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
        return { rpc, profile };
      } catch (error) {
        rpc.close();
        throw error;
      }
    }
    throw new Error("Codex external tools could not be isolated");
  }
  async models() {
    const { rpc } = await this.open(homedir(), "read");
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
  async start(input: Parameters<LocalAgentEngine["start"]>[0]): Promise<LocalAgentExecution> {
    const { rpc, profile } = await this.open(input.cwd, input.request.access);
    let threadId: string | undefined;
    let turnId: string | undefined;
    let settled = false;
    let stopping = false;
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
      if (status) resolve(status);
      else reject(new Error("Codex turn did not complete"));
      rpc.close();
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
        await input.emit({ type: "interaction", interaction });
        return;
      }
      if (p.threadId !== threadId) return;
      if (message.method === "turn/started") {
        if (turnId && p.turn?.id !== turnId) return;
        turnId = p.turn?.id;
      }
      if (p.turnId && turnId && p.turnId !== turnId) return;
      if (
        message.method === "item/started" &&
        p.item?.type === "fileChange" &&
        Array.isArray(p.item.changes)
      )
        fileChanges.set(p.item.id, p.item.changes);
      if (message.method === "item/agentMessage/delta" && typeof p.delta === "string")
        await input.emit({ type: "text", text: p.delta });
      if (
        message.method === "item/started" &&
        ["commandExecution", "fileChange"].includes(p.item?.type)
      )
        await input.emit({ type: "activity", text: p.item.command ?? "Local file changes" });
      if (message.method === "turn/completed" && p.turn?.id === turnId)
        finish(
          p.turn.status === "completed"
            ? "completed"
            : p.turn.status === "interrupted"
              ? "cancelled"
              : undefined,
        );
      if (message.method === "error") finish();
    };
    rpc.listen(
      (message) => {
        events = events.then(() => handle(message)).catch(() => finish());
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
      const started = await rpc.request(input.sessionRef ? "thread/resume" : "thread/start", {
        ...selection,
        ...(input.sessionRef ? { threadId: input.sessionRef } : { ephemeral: false }),
      });
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
      await input.session(threadId!);
      input.signal?.throwIfAborted();
      const turn = await rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.request.prompt }],
        clientUserMessageId: input.request.runId,
        permissions: profile,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      });
      if (typeof turn.turn?.id !== "string") throw new Error("Invalid native turn");
      turnId = turn.turn.id;
    } catch (error) {
      finish();
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
      async cancel() {
        if (settled) return;
        stopping = true;
        try {
          await rpc.request("turn/interrupt", { threadId, turnId }, 750);
        } catch {
          /* The owned process group is the bounded fallback. */
        }
        finish("cancelled");
      },
    };
  }
}
