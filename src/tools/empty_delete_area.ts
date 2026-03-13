import type { ToolDefinition } from "../llm/types.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { emptyWorkspaceTrash } from "./trash.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";

export const emptyDeleteAreaTool = {
  definition: {
    name: "empty_delete_area",
    description:
      "Permanently delete every file in SuperRun's delete area for this workspace. This is irreversible.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
      if (Object.keys(parsed).length > 0) {
        throw new Error("empty_delete_area does not accept arguments.");
      }

      const result = await emptyWorkspaceDeleteArea(context);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown empty_delete_area error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function emptyWorkspaceDeleteArea(
  context?: ToolExecutionContext,
): Promise<{
  purgedCount: number;
  deleteArea: {
    fileCount: number;
    totalBytes: number;
  };
}> {
  const assessment: WorkspaceEditAssessment = {
    tool: "empty_delete_area",
    path: "(delete area)",
    summary: "Permanently empty the delete area",
    reasons: [
      "emptying the delete area is irreversible for every stored file.",
    ],
    approvalRequired: true,
  };
  await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  const result = await emptyWorkspaceTrash();
  return {
    purgedCount: result.purgedCount,
    deleteArea: result.status,
  };
}
