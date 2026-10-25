import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalAgentPrivateFile } from "@rakazo/adapters/local-agent-host";
import { localAgentLaunchAgent } from "../src/launch-agent.js";

if (process.platform !== "darwin") throw new Error("LaunchAgent installation requires macOS");
const config = process.argv[2];
if (!config || !path.isAbsolute(config))
  throw new Error("Pass an absolute private configuration file");
await readLocalAgentPrivateFile(config);
const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const directory = path.dirname(path.dirname(path.dirname(path.dirname(entry))));
const destination = path.join(homedir(), "Library", "LaunchAgents", "com.rakazo.local-agent.plist");
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(
  destination,
  localAgentLaunchAgent({
    node: process.execPath,
    tsx: require.resolve("tsx/cli"),
    entry,
    config,
    directory,
  }),
  { flag: "wx", mode: 0o600 },
);
process.stdout.write("LaunchAgent file created; load it explicitly with launchctl.\n");
