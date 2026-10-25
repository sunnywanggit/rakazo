import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { codexLocalArguments, codexLocalEnvironment } from "@rakazo/adapters/codex-app-server";

const exec = promisify(execFile);
const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable))
  throw new Error("Pass an absolute Codex executable path");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-sandbox-canary-")));
try {
  const project = path.join(root, "project");
  await mkdir(project);
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "outside");
  await writeFile(path.join(project, ".env"), "private-fixture");
  await writeFile(path.join(project, "read.txt"), "project");
  const probe = async (access: "read" | "write", script: string) => {
    const profile = "rakazo_canary";
    const args = [
      "sandbox",
      "-P",
      profile,
      "-C",
      project,
      ...codexLocalArguments(project, access, profile).slice(3),
      "--",
      "/bin/sh",
      "-c",
      script,
    ];
    try {
      await exec(executable, args, {
        cwd: project,
        env: codexLocalEnvironment(process.env),
        timeout: 15_000,
      });
      return true;
    } catch {
      return false;
    }
  };
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const checks = {
    projectRead: await probe("read", "/bin/cat read.txt"),
    outsideReadBlocked: !(await probe("read", `/bin/cat ${quote(outside)}`)),
    secretReadBlocked: !(await probe("read", "/bin/cat .env")),
    readOnlyWriteBlocked: !(await probe("read", "echo changed > blocked.txt")),
    projectWrite: await probe("write", "echo changed > allowed.txt"),
    outsideWriteBlocked: !(await probe("write", `echo changed > ${quote(outside)}`)),
    outsideUnchanged: (await readFile(outside, "utf8")) === "outside",
  };
  process.stdout.write(`${JSON.stringify(checks)}\n`);
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
