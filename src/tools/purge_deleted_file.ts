import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { purgeWorkspaceFileFromTrash } from "./trash.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";

const purgeDeletedFileArgsSchema = z.object({
  id: z.string().trim().min(1),
});

type PurgeDeletedFileArgs = z.infer<typeof purgeDeletedFileArgsSchema>;

export const purgeDeletedFileTool = {
  definition: {
    name: "purge_deleted_file",
    description:
      "Permanently delete one file from SuperRun's delete area. This is irreversible.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Delete-area file id to purge permanently.",
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
      const parsedArgs = parsePurgeDeletedFileArgs(rawArguments);
      const result = await purgeDeletedWorkspaceFile(parsedArgs, context);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown purge_deleted_file error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function purgeDeletedWorkspaceFile(
  args: PurgeDeletedFileArgs,
  context?: ToolExecutionContext,
): Promise<{
  purgedId: string;
  originalPath: string;
  deleteArea: {
    fileCount: number;
    totalBytes: number;
  };
}> {
  const assessment: WorkspaceEditAssessment = {
    tool: "purge_deleted_file",
    path: args.id,
    summary: "Permanently delete one file from the delete area",
    reasons: [
      "purging a deleted file is irreversible.",
    ],
    approvalRequired: true,
  };
  await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  const result = await purgeWorkspaceFileFromTrash(args.id);
  return {
    purgedId: result.entry.id,
    originalPath: result.entry.originalPath,
    deleteArea: result.status,
  };
}

function parsePurgeDeletedFileArgs(rawArguments: string): PurgeDeletedFileArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return purgeDeletedFileArgsSchema.parse(parsed);
}
