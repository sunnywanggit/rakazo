/** Only application-owned failure codes may cross the native engine boundary. */
export const localAgentFailureMessages = {
  inUse: "Local session is open in another app. Release it there, then try again.",
  failed: "Local agent execution failed",
  cancelled: "Local agent execution stopped",
  uncertain: "Local execution is uncertain; the task was not replayed",
} as const;

export function localAgentFailureCode(value: unknown): "local_session_in_use" | null {
  return value === "local_session_in_use" ? value : null;
}

export function localAgentFailureMessage(status: string, code?: string | null): string {
  if (status === "uncertain") return localAgentFailureMessages.uncertain;
  if (status === "cancelled") return localAgentFailureMessages.cancelled;
  if (localAgentFailureCode(code)) return localAgentFailureMessages.inUse;
  return localAgentFailureMessages.failed;
}
