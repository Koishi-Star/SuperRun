export const AGENT_MODES = ["default", "strict"] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

export function parseAgentMode(value: string | null | undefined): AgentMode {
  const normalized = value?.trim().toLowerCase() ?? "default";

  if (normalized === "default" || normalized === "strict") {
    return normalized;
  }

  throw new Error(`Invalid agent mode: ${value}. Use "default" or "strict".`);
}

export function getAgentModeSummary(mode: AgentMode): string {
  if (mode === "strict") {
    return "strict (specialized read-only tools only)";
  }

  return "default (command execution enabled)";
}
