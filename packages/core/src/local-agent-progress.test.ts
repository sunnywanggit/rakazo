import { expect, it } from "vitest";
import { localAgentProgress, localAgentProgressLabel } from "./local-agent-progress.js";

it("localizes application-owned stages while leaving public summary text untouched", () => {
  const labels = {
    connecting: "a",
    restoring: "b",
    waiting: "c",
    thinking: "d",
    retrying: "e",
    limited: "f",
  };
  for (const key of Object.keys(labels) as Array<keyof typeof labels>)
    expect(localAgentProgressLabel(localAgentProgress[key], labels)).toBe(labels[key]);
  expect(localAgentProgressLabel("Fixture public summary", labels)).toBe("Fixture public summary");
  expect(localAgentProgressLabel(undefined, labels)).toBeUndefined();
});
