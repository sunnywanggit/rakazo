import type { MessageBlock } from "@rakazo/contracts";
import { LocalAgentUserDecisionSchema } from "@rakazo/contracts";

/** Only explicit card controls call this; ordinary chat text never becomes authorization. */
export function localAgentCardDecision(
  block: Extract<MessageBlock, { kind: "ask" }>,
  value: string,
) {
  if (!block.runtimeInteractionId) throw new Error("Not a local agent interaction");
  if (block.runtimeQuestions) {
    const answers = JSON.parse(value);
    const decision = LocalAgentUserDecisionSchema.parse({ decision: "answer", answers });
    if (block.runtimeQuestions.some((question) => !decision.answers?.[question.id]?.trim()))
      throw new Error("Complete every question");
    return decision;
  }
  return LocalAgentUserDecisionSchema.parse({ decision: value });
}
