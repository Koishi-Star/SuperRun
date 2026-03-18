import type { AgentMode } from "../agent/mode.js";
import type { ToolCall, ToolDefinition } from "../llm/types.js";
import { deleteFileTool } from "./delete_file.js";
import { emptyDeleteAreaTool } from "./empty_delete_area.js";
import { fetchWebpageTool } from "./fetch_webpage.js";
import { insertLinesTool } from "./insert_lines.js";
import { listFilesTool } from "./list_files.js";
import { listDeletedFilesTool } from "./list_deleted_files.js";
import { purgeDeletedFileTool } from "./purge_deleted_file.js";
import { readFileTool } from "./read_file.js";
import { replaceLinesTool } from "./replace_lines.js";
import { requestUserInputTool } from "./request_user_input.js";
import { restoreDeletedFileTool } from "./restore_deleted_file.js";
import { runCommandTool } from "./run_command.js";
import { searchWorkspaceTool } from "./search_workspace.js";
import { getSymbolsTool } from "./get_symbols.js";
import { getSymbolSourceTool } from "./get_symbol_source.js";
import { replaceSymbolBodyTool } from "./replace_symbol_body.js";
import { insertBeforeSymbolTool, insertAfterSymbolTool } from "./insert_near_symbol.js";
import { runValidationTool } from "./run_validation.js";
import { applyPatchTool } from "./apply_patch.js";
import type { ToolExecutionContext } from "./types.js";
import { updatePlanTool } from "./update_plan.js";
import { writeFileTool } from "./write_file.js";

const defaultModeBaseTools = [
  fetchWebpageTool,
  updatePlanTool,
  searchWorkspaceTool,
  runCommandTool,
  readFileTool,
  getSymbolsTool,
  getSymbolSourceTool,
  replaceSymbolBodyTool,
  insertBeforeSymbolTool,
  insertAfterSymbolTool,
  applyPatchTool,
  runValidationTool,
  writeFileTool,
  replaceLinesTool,
  insertLinesTool,
  deleteFileTool,
  listDeletedFilesTool,
  restoreDeletedFileTool,
  purgeDeletedFileTool,
  emptyDeleteAreaTool,
] as const;
const strictModeTools = [
  updatePlanTool,
  listFilesTool,
  searchWorkspaceTool,
  readFileTool,
  getSymbolsTool,
  getSymbolSourceTool,
  listDeletedFilesTool,
] as const;
const planModeBaseTools = [listFilesTool, searchWorkspaceTool, readFileTool] as const;

export function getAgentToolDefinitions(
  mode: AgentMode,
  context?: ToolExecutionContext,
): ToolDefinition[] {
  return getAgentTools(mode, context).map((tool) => tool.definition);
}

export async function executeAgentTool(
  toolCall: ToolCall,
  mode: AgentMode,
  context?: ToolExecutionContext,
): Promise<string> {
  const tool = getAgentTools(mode, context).find(
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

function getAgentTools(mode: AgentMode, context?: ToolExecutionContext) {
  const includeRequestUserInput = Boolean(context?.userInput?.requestUserInput);

  if (mode === "strict") {
    return strictModeTools;
  }

  if (mode === "plan") {
    return includeRequestUserInput
      ? [...planModeBaseTools, requestUserInputTool]
      : planModeBaseTools;
  }

  return includeRequestUserInput
    ? [fetchWebpageTool, updatePlanTool, requestUserInputTool, ...defaultModeBaseTools.slice(2)]
    : defaultModeBaseTools;
}
