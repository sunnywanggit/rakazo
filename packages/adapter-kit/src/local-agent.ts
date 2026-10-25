import type {
  LocalAgentDecision,
  LocalAgentEvent,
  LocalAgentSessionSelector,
  LocalAgentStart,
} from "@rakazo/contracts";

/** Native engine boundary. The host owns authorization, journals and process lifetime. */
export interface LocalAgentEngine {
  readonly id: string;
  readonly supportsSessionReuse?: boolean;
  /** Release the binding, including any idle native process. Never accepts native identifiers. */
  release?(session: LocalAgentSessionSelector): Promise<void>;
  close?(): Promise<void>;
  models(): Promise<Array<{ id: string; label: string }>>;
  start(input: {
    request: LocalAgentStart;
    cwd: string;
    sessionRef?: string;
    reuse?: boolean;
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
