import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Metadata only: credentials and instruction bodies are never read or returned. */
async function identity(file: string) {
  try {
    const resolved = await realpath(file);
    const stat = await lstat(resolved, { bigint: true });
    return (
      stat.isDirectory()
        ? [resolved, stat.dev, stat.ino, stat.mode, stat.uid, stat.gid]
        : [resolved, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    ).join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${file}:absent`;
    throw new Error("Local engine state could not be verified");
  }
}

export async function codexExecutableIdentity(executable: string) {
  return createHash("sha256")
    .update(await identity(executable))
    .digest("hex");
}

export async function codexLocalState(
  env: NodeJS.ProcessEnv,
  cwd?: string,
  sources: string[] = [],
) {
  if (!env.HOME || !path.isAbsolute(env.HOME)) throw new Error("Local engine home is unavailable");
  const home = env.CODEX_HOME ?? path.join(env.HOME, ".codex");
  if (!path.isAbsolute(home)) throw new Error("Local engine home must be absolute");
  const files = new Set([
    path.join(home, "auth.json"),
    path.join(home, "config.toml"),
    path.join(home, "AGENTS.md"),
    path.join(home, "AGENTS.override.md"),
    path.join(home, "requirements.toml"),
    "/etc/codex/config.toml",
    "/etc/codex/requirements.toml",
    ...sources,
  ]);
  if ([...files].some((file) => !path.isAbsolute(file)))
    throw new Error("Unverifiable local instruction source");
  if (cwd) {
    let root = cwd;
    // Native project configuration and instructions can come from ancestor directories.
    while (true) {
      for (const name of ["AGENTS.md", "AGENTS.override.md", ".codex/config.toml"])
        files.add(path.join(root, name));
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
    files.add(cwd);
  }
  const identities = await Promise.all([...files].sort().map(identity));
  return createHash("sha256")
    .update(JSON.stringify([env, identities]))
    .digest("hex");
}
