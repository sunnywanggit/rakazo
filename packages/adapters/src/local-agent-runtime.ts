import type { AdapterContext, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { LocalAgentStart } from "@rakazo/contracts";
import { LocalAgentDecisionSchema } from "@rakazo/contracts";
import type { LocalAgentClient } from "./local-agent-client.js";

export type LocalAgentRuntimeRequest = LocalAgentStart & {
  cursor: number;
  allowCreate: boolean;
  decisions: Array<{ id: string; value: string }>;
};

/** Host events are already normalized by the native adapter; only the durable cursor is added. */
export class LocalAgentRuntime implements AgentRuntime<LocalAgentRuntimeRequest> {
  private readonly active = new Map<string, { fence: number; controller: AbortController }>();
  constructor(private readonly client: LocalAgentClient) {}
  describe() {
    return {
      id: "local-agent",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }
  async *run(
    request: LocalAgentRuntimeRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const { cursor, decisions, allowCreate, ...start } = request;
    const controller = new AbortController();
    const signal = context?.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    this.active.set(start.runId, { fence: start.fence, controller });
    try {
      // A recovered worker must find the original durable host receipt before attaching.
      // A missing receipt never becomes permission to submit the task again.
      if (!allowCreate) await this.client.status(start.runId);
      await this.client.start(start, signal);
      for (const decision of decisions)
        await this.client.respond(
          start.runId,
          decision.id,
          LocalAgentDecisionSchema.parse({ ...JSON.parse(decision.value), fence: start.fence }),
        );
      for await (const envelope of this.client.events(start.runId, cursor, signal))
        yield { type: "host", envelope };
    } finally {
      // Ending the consumer at a persisted interaction is suspension, not process cancellation.
      this.active.delete(start.runId);
    }
  }
  async abort(runId: string) {
    const active = this.active.get(runId);
    if (!active) return;
    active.controller.abort();
    await this.client.cancel(runId, active.fence);
  }
}
