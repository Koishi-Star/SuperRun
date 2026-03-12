import type { ToolCall, ToolDefinition } from "../llm/types.js";
import { listFilesTool } from "./list_files.js";

const agentTools = [listFilesTool] as const;

export function getAgentToolDefinitions(): ToolDefinition[] {
  return agentTools.map((tool) => tool.definition);
}

export async function executeAgentTool(toolCall: ToolCall): Promise<string> {
  const tool = agentTools.find(
    (candidate) => candidate.definition.name === toolCall.name,
  );

  if (!tool) {
    return JSON.stringify({
      ok: false,
      error: `Unknown tool: ${toolCall.name}`,
    });
  }

  return tool.execute(toolCall.arguments);
}
