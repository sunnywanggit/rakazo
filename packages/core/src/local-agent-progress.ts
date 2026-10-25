/** Stable v1 activity text. Only these application-owned labels are localized. */
export const localAgentProgress = {
  connecting: "Connecting…",
  restoring: "Restoring session…",
  waiting: "Waiting for model…",
  thinking: "Thinking…",
  retrying: "Retrying…",
  limited: "Rate limited; waiting to retry…",
} as const;

export function localAgentProgressLabel(
  text: string | undefined,
  labels: Record<keyof typeof localAgentProgress, string>,
): string | undefined {
  for (const key of Object.keys(localAgentProgress) as Array<keyof typeof localAgentProgress>)
    if (text === localAgentProgress[key]) return labels[key];
  return text;
}
