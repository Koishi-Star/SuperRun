import type { ToolDefinition } from "../llm/types.js";
import { listWorkspaceTrashEntries } from "./trash.js";
import type { ToolExecutionContext } from "./types.js";

export const listDeletedFilesTool = {
  definition: {
    name: "list_deleted_files",
    description:
      "List files currently stored in SuperRun's delete area for this workspace so they can be restored or purged later.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    _context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
      if (Object.keys(parsed).length > 0) {
        throw new Error("list_deleted_files does not accept arguments.");
      }

      const result = await listWorkspaceTrashEntries();
      return JSON.stringify({
        ok: true,
        entries: result.entries,
        deleteArea: result.status,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown list_deleted_files error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};
