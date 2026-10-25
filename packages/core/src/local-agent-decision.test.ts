import { expect, it } from "vitest";
import { localAgentCardDecision } from "./local-agent-decision.js";

it("only builds decisions for explicit local cards with complete structured answers", () => {
  const card = { kind: "ask" as const, text: "Approve", runtimeInteractionId: "request" };
  expect(localAgentCardDecision(card, "allow")).toEqual({ decision: "allow" });
  expect(() => localAgentCardDecision(card, "always")).toThrow();
  expect(() => localAgentCardDecision({ kind: "ask", text: "ordinary" }, "allow")).toThrow();
  const question = { ...card, runtimeQuestions: [{ id: "file", question: "Which file?" }] };
  expect(() => localAgentCardDecision(question, "allow")).toThrow();
  expect(() => localAgentCardDecision(question, "{}")).toThrow();
  expect(localAgentCardDecision(question, '{"file":"one"}')).toEqual({
    decision: "answer",
    answers: { file: "one" },
  });
});
