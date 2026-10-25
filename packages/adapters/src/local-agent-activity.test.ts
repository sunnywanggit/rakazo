import type { LocalAgentEvent } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { localAgentActivity } from "./local-agent-activity.js";

afterEach(() => vi.useRealTimers());

it("bounds and coalesces public summaries before persistence, dropping delayed status at boundaries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const emit = vi.fn<(event: LocalAgentEvent) => Promise<void>>(async () => {});
  const activity = localAgentActivity(emit);
  await activity.phase("Waiting for model…");
  for (let i = 0; i < 100; i++) activity.summary("one", "x".repeat(100));
  await vi.advanceTimersByTimeAsync(250);
  expect(emit).toHaveBeenCalledTimes(2);
  expect(emit.mock.calls[1]![0]).toEqual({ type: "activity", text: "x".repeat(200) });
  activity.summary("two", "must not appear after reply");
  await activity.barrier();
  await vi.advanceTimersByTimeAsync(500);
  expect(emit).toHaveBeenCalledTimes(2);
  await activity.close();
  activity.summary("three", "must not appear after terminal");
  await activity.phase("ignored");
  await vi.advanceTimersByTimeAsync(500);
  expect(emit).toHaveBeenCalledTimes(2);
});
