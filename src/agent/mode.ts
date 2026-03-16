export const AGENT_MODES = ["default", "strict", "plan"] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

export function parseAgentMode(value: string | null | undefined): AgentMode {
  const normalized = value?.trim().toLowerCase() ?? "default";

  if (normalized === "default" || normalized === "strict" || normalized === "plan") {
    return normalized;
  }

  throw new Error(`Invalid agent mode: ${value}. Use "default", "strict", or "plan".`);
}

export function getAgentModeSummary(mode: AgentMode): string {
  if (mode === "plan") {
    return "plan (read-only repository inspection and suggestions only)";
  }

  if (mode === "strict") {
    return "strict (specialized read-only tools only)";
  }

  return "default (command execution enabled)";
}
