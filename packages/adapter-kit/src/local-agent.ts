import type { LocalAgentDecision, LocalAgentEvent, LocalAgentStart } from "@rakazo/contracts";

/** Native engine boundary. The host owns authorization, journals and process lifetime. */
export interface LocalAgentEngine {
  readonly id: string;
  models(): Promise<Array<{ id: string; label: string }>>;
  start(input: {
    request: LocalAgentStart;
    cwd: string;
    sessionRef?: string;
    signal?: AbortSignal;
    session: (reference: string) => Promise<void>;
    emit: (event: LocalAgentEvent) => Promise<void>;
  }): Promise<LocalAgentExecution>;
}

export interface LocalAgentExecution {
  completion: Promise<"completed" | "cancelled">;
  respond(interactionId: string, decision: LocalAgentDecision): Promise<void>;
  cancel(): Promise<void>;
}
