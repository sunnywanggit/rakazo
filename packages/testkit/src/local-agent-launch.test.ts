import { expect, it } from "vitest";
import { localAgentLaunchAgent } from "../../../apps/local-agent/src/launch-agent.js";

it("renders literal LaunchAgent arguments without a shell or credential value", () => {
  const plist = localAgentLaunchAgent({
    node: "/runtime/node",
    tsx: "/runtime/tsx",
    entry: "/workspace/source.ts",
    config: "/private/owner & app/config.json",
    directory: "/workspace",
  });
  expect(plist).toContain("/private/owner &amp; app/config.json");
  expect(plist).toContain("<key>ProgramArguments</key>");
  expect(plist).not.toContain("/bin/sh");
  expect(() =>
    localAgentLaunchAgent({
      node: "node",
      tsx: "/tsx",
      entry: "/entry",
      config: "/config",
      directory: "/workspace",
    }),
  ).toThrow();
});
