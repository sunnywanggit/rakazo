import { CodexAppServerEngine } from "@rakazo/adapters/codex-app-server";
import { readLocalAgentPrivateFile, startLocalAgentHost } from "@rakazo/adapters/local-agent-host";
import { z } from "zod";

const configSchema = z.strictObject({
  root: z.string().min(1),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  hostname: z.string().default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535),
  allowedHosts: z.array(z.string().min(1)).min(1),
  engine: z.strictObject({ kind: z.literal("codex"), executable: z.string().min(1) }),
  lifecycle: z
    .strictObject({
      enabled: z.boolean().default(false),
      idleTtlMs: z.number().int().min(1_000).max(300_000).default(300_000),
      maxIdleSessions: z.number().int().min(1).max(2).default(2),
    })
    .default({ enabled: false, idleTtlMs: 300_000, maxIdleSessions: 2 }),
  projects: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        label: z.string().max(120),
        root: z.string().min(1),
        access: z.enum(["read", "write"]),
      }),
    )
    .min(1),
  bindings: z
    .array(
      z.strictObject({
        spaceId: z.string().min(1),
        userId: z.string().min(1),
        botId: z.string().min(1),
        projects: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});

/** Configuration stays in a private file; no credential is passed on the process command line. */
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--config")
    throw new Error("Expected --config with a private configuration file");
  const config = configSchema.parse(await readLocalAgentPrivateFile(process.argv[3]!));
  const engine = new CodexAppServerEngine({
    executable: config.engine.executable,
    reusePolicy: config.lifecycle,
    onTiming: (sample) =>
      process.stdout.write(`${JSON.stringify({ event: "local_agent.phase", ...sample })}\n`),
  });
  const host = await startLocalAgentHost({
    ...config,
    engine,
    sessionReuse: config.lifecycle.enabled,
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await host.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    });
}

void main().catch(() => {
  // A parsed configuration or CLI error can contain a private value. Keep startup output generic.
  process.stderr.write(
    "Local agent could not start. Check the private configuration and CLI installation.\n",
  );
  process.exitCode = 1;
});
