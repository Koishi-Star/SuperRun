import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { restoreWorkspaceFileFromTrash } from "./trash.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";

const restoreDeletedFileArgsSchema = z.object({
  id: z.string().trim().min(1),
});

type RestoreDeletedFileArgs = z.infer<typeof restoreDeletedFileArgsSchema>;

export const restoreDeletedFileTool = {
  definition: {
    name: "restore_deleted_file",
    description:
      "Restore a file from SuperRun's delete area back into the workspace. If the original path already exists, the restored file is renamed with a -recover suffix.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Delete-area file id previously returned by delete_file.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseRestoreDeletedFileArgs(rawArguments);
      const result = await restoreDeletedWorkspaceFile(parsedArgs, context);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown restore_deleted_file error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function restoreDeletedWorkspaceFile(
  args: RestoreDeletedFileArgs,
  context?: ToolExecutionContext,
): Promise<{
  restoredPath: string;
  originalPath: string;
  deleteArea: {
    fileCount: number;
    totalBytes: number;
  };
}> {
  const assessment: WorkspaceEditAssessment = {
    tool: "restore_deleted_file",
    path: args.id,
    summary: "Restore a file from the delete area",
    reasons: [
      "restoring files writes content back into the workspace.",
    ],
    approvalRequired: true,
  };
  await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  const result = await restoreWorkspaceFileFromTrash(args.id);
  return {
    restoredPath: result.restoredPath,
    originalPath: result.entry.originalPath,
    deleteArea: result.status,
  };
}

function parseRestoreDeletedFileArgs(rawArguments: string): RestoreDeletedFileArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return restoreDeletedFileArgsSchema.parse(parsed);
}
