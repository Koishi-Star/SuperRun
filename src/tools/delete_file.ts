import { lstat } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { moveWorkspaceFileToTrash } from "./trash.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";
import {
  normalizeRelativeWorkspacePath,
  resolveWorkspacePath,
} from "./workspace.js";

const deleteFileArgsSchema = z.object({
  path: z.string().trim().min(1),
});

const MAX_DELETE_AREA_FILE_BYTES = 1_024 * 1_024;

type DeleteFileArgs = z.infer<typeof deleteFileArgsSchema>;

export const deleteFileTool = {
  definition: {
    name: "delete_file",
    description:
      "Remove a workspace file by moving it into SuperRun's delete area. The file is not purged immediately and can be restored later.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to remove.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseDeleteFileArgs(rawArguments);
      const result = await deleteWorkspaceFile(parsedArgs, context);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown delete_file error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function deleteWorkspaceFile(
  args: DeleteFileArgs,
  context?: ToolExecutionContext,
): Promise<{
  path: string;
  deletedFileId: string;
  deletedAt: string;
  deleteArea: {
    fileCount: number;
    totalBytes: number;
  };
}> {
  const relativePath = normalizeRelativeWorkspacePath("delete_file", args.path);
  const absolutePath = resolveWorkspacePath("delete_file", process.cwd(), relativePath);
  const stat = await lstat(absolutePath);

  if (stat.size > MAX_DELETE_AREA_FILE_BYTES) {
    context?.notices?.addNotice({
      level: "warning",
      message: `Skipped delete area move for ${relativePath}: files larger than 1 MB must be deleted manually.`,
    });
    throw new Error(
      `delete_file refuses to store files larger than 1 MB in the delete area: ${relativePath}`,
    );
  }

  const assessment: WorkspaceEditAssessment = {
    tool: "delete_file",
    path: relativePath,
    summary: "Move a workspace file into the delete area",
    reasons: [
      "deleting files changes the workspace and may remove important code or assets.",
    ],
    approvalRequired: true,
  };
  await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  const result = await moveWorkspaceFileToTrash("delete_file", relativePath);
  return {
    path: result.entry.originalPath,
    deletedFileId: result.entry.id,
    deletedAt: result.entry.deletedAt,
    deleteArea: result.status,
  };
}

function parseDeleteFileArgs(rawArguments: string): DeleteFileArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return deleteFileArgsSchema.parse(parsed);
}
