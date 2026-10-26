import { describe, expect, it } from "vitest";
import { localAgentFailureCode, localAgentFailureMessage } from "./local-agent-failure.js";

describe("local execution failures", () => {
  it("distinguishes a failed run from a stopped or uncertain run", () => {
    expect(localAgentFailureMessage("failed")).toBe("Local agent execution failed");
    expect(localAgentFailureMessage("cancelled")).toBe("Local agent execution stopped");
    expect(localAgentFailureMessage("uncertain")).toContain("not replayed");
  });

  it("exposes an actionable session conflict without echoing native details", () => {
    expect(localAgentFailureCode("local_session_in_use")).toBe("local_session_in_use");
    expect(localAgentFailureMessage("failed", "local_session_in_use")).toBe(
      "Local session is open in another app. Release it there, then try again.",
    );
    expect(localAgentFailureCode("PRIVATE_NATIVE_DETAILS")).toBeNull();
    expect(localAgentFailureMessage("failed", "PRIVATE_NATIVE_DETAILS")).toBe(
      "Local agent execution failed",
    );
    expect(localAgentFailureMessage("cancelled", "local_session_in_use")).toBe(
      "Local agent execution stopped",
    );
  });
});
