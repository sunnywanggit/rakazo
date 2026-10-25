import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9:_-]+$/);
export const LocalAgentScopeSchema = z.strictObject({
  spaceId: id,
  userId: id,
  botId: id,
  threadId: id,
});
export const LocalAgentAccessSchema = z.enum(["read", "write"]);
export const LocalAgentStartSchema = z.strictObject({
  scope: LocalAgentScopeSchema,
  runId: id,
  sessionId: id,
  projectId: id,
  model: z.string().min(1).max(200),
  access: LocalAgentAccessSchema,
  prompt: z.string().min(1).max(64_000),
  instructions: z.string().max(64_000),
  fence: z.number().int().positive(),
});
export const LocalAgentQuestionSchema = z.strictObject({
  id,
  question: z.string().min(1).max(4_000),
  options: z.array(z.string().max(1_000)).max(20).optional(),
});
export const LocalAgentInteractionSchema = z.strictObject({
  id,
  kind: z.enum(["approval", "question"]),
  summary: z.string().min(1).max(4_000),
  detail: z.string().max(16_000).optional(),
  questions: z.array(LocalAgentQuestionSchema).max(10).optional(),
  expiresAt: z.string().datetime(),
});
export const LocalAgentDecisionSchema = z.strictObject({
  fence: z.number().int().positive(),
  decision: z.enum(["allow", "deny", "answer"]),
  answers: z.record(z.string(), z.string().max(8_000)).optional(),
});
export const LocalAgentEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().max(64_000) }),
  z.strictObject({ type: z.literal("activity"), text: z.string().max(16_000) }),
  z.strictObject({ type: z.literal("interaction"), interaction: LocalAgentInteractionSchema }),
  z.strictObject({ type: z.literal("resolved"), interactionId: id }),
  z.strictObject({
    type: z.literal("terminal"),
    status: z.enum(["completed", "failed", "cancelled", "uncertain"]),
    error: z.string().max(1_000).optional(),
  }),
]);
export const LocalAgentEnvelopeSchema = z.strictObject({
  sequence: z.number().int().positive(),
  event: LocalAgentEventSchema,
});
export const LocalAgentCapabilitiesSchema = z.strictObject({
  protocol: z.literal(1),
  engine: z.string().min(1).max(80),
  projects: z.array(
    z.strictObject({ id, label: z.string().max(120), access: LocalAgentAccessSchema }),
  ),
  models: z.array(z.strictObject({ id: z.string().min(1).max(200), label: z.string().max(200) })),
});
export const LocalAgentStatusSchema = z.strictObject({
  runId: id,
  status: z.enum([
    "starting",
    "running",
    "waiting_input",
    "completed",
    "failed",
    "cancelled",
    "uncertain",
  ]),
  sequence: z.number().int().nonnegative(),
  interaction: LocalAgentInteractionSchema.nullable(),
});
export type LocalAgentScope = z.infer<typeof LocalAgentScopeSchema>;
export type LocalAgentStart = z.infer<typeof LocalAgentStartSchema>;
export type LocalAgentEvent = z.infer<typeof LocalAgentEventSchema>;
export type LocalAgentEnvelope = z.infer<typeof LocalAgentEnvelopeSchema>;
export type LocalAgentDecision = z.infer<typeof LocalAgentDecisionSchema>;
export type LocalAgentInteraction = z.infer<typeof LocalAgentInteractionSchema>;
export type LocalAgentCapabilities = z.infer<typeof LocalAgentCapabilitiesSchema>;
