import type { AgentMode } from "../agent/mode.js";
import type { ToolCall, ToolDefinition } from "../llm/types.js";
import { listFilesTool } from "./list_files.js";
import { runCommandTool } from "./run_command.js";
import type { ToolExecutionContext } from "./types.js";

const defaultModeTools = [runCommandTool] as const;
const strictModeTools = [listFilesTool] as const;

export function getAgentToolDefinitions(mode: AgentMode): ToolDefinition[] {
  return getAgentTools(mode).map((tool) => tool.definition);
}

export async function executeAgentTool(
  toolCall: ToolCall,
  mode: AgentMode,
  context?: ToolExecutionContext,
): Promise<string> {
  const tool = getAgentTools(mode).find(
    (candidate) => candidate.definition.name === toolCall.name,
  );

  if (!tool) {
    return JSON.stringify({
      ok: false,
      error: `Unknown tool for ${mode} mode: ${toolCall.name}`,
    });
  }

  return tool.execute(toolCall.arguments, context);
}

function getAgentTools(mode: AgentMode) {
  return mode === "strict" ? strictModeTools : defaultModeTools;
}
