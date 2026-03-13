import type { AgentMode } from "../agent/mode.js";
import type { ToolCall, ToolDefinition } from "../llm/types.js";
import { deleteFileTool } from "./delete_file.js";
import { emptyDeleteAreaTool } from "./empty_delete_area.js";
import { insertLinesTool } from "./insert_lines.js";
import { listFilesTool } from "./list_files.js";
import { listDeletedFilesTool } from "./list_deleted_files.js";
import { purgeDeletedFileTool } from "./purge_deleted_file.js";
import { readFileTool } from "./read_file.js";
import { replaceLinesTool } from "./replace_lines.js";
import { restoreDeletedFileTool } from "./restore_deleted_file.js";
import { runCommandTool } from "./run_command.js";
import type { ToolExecutionContext } from "./types.js";
import { writeFileTool } from "./write_file.js";

const defaultModeTools = [
  runCommandTool,
  readFileTool,
  writeFileTool,
  replaceLinesTool,
  insertLinesTool,
  deleteFileTool,
  listDeletedFilesTool,
  restoreDeletedFileTool,
  purgeDeletedFileTool,
  emptyDeleteAreaTool,
] as const;
const strictModeTools = [listFilesTool, readFileTool, listDeletedFilesTool] as const;

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
