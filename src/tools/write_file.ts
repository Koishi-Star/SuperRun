import path from "node:path";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { buildWorkspaceEditDiffPreview } from "./diff_preview.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { parseWorkspaceText } from "./text_file.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";
import {
  normalizeRelativeWorkspacePath,
  resolveWorkspacePath,
} from "./workspace.js";

const writeFileArgsSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  create_if_missing: z.boolean().optional(),
  overwrite: z.boolean().optional(),
});

type WriteFileArgs = z.infer<typeof writeFileArgsSchema>;

export const writeFileTool = {
  definition: {
    name: "write_file",
    description:
      "Create a new UTF-8 text file or fully overwrite an existing UTF-8 text file in the workspace. Prefer this over shell redirection for explicit file writes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to create or overwrite.",
        },
        content: {
          type: "string",
          description: "Full file content to write as UTF-8 text.",
        },
        create_if_missing: {
          type: "boolean",
          description: "Whether a missing file may be created. Defaults to true.",
        },
        overwrite: {
          type: "boolean",
          description: "Whether an existing file may be replaced. Defaults to false.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseWriteFileArgs(rawArguments);
      const result = await writeWorkspaceFile(parsedArgs, context);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown write_file error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function writeWorkspaceFile(
  args: WriteFileArgs,
  context?: ToolExecutionContext,
): Promise<{
  path: string;
  created: boolean;
  overwritten: boolean;
  bytesWritten: number;
}> {
  const relativePath = normalizeRelativeWorkspacePath("write_file", args.path);
  const absolutePath = resolveWorkspacePath("write_file", process.cwd(), relativePath);
  const createIfMissing = args.create_if_missing ?? true;
  const overwrite = args.overwrite ?? false;

  let existingStat: Awaited<ReturnType<typeof lstat>> | null = null;
  let existingContent = "";
  try {
    existingStat = await lstat(absolutePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  if (existingStat?.isDirectory()) {
    throw new Error("write_file path must point to a file, not a directory.");
  }

  if (existingStat) {
    existingContent = await readFile(absolutePath, "utf8");
  }

  const previousText = parseWorkspaceText(existingContent);
  const nextText = parseWorkspaceText(args.content);

  if (!existingStat && !createIfMissing) {
    throw new Error(`write_file target does not exist: ${relativePath}`);
  }

  if (existingStat && !overwrite) {
    throw new Error(
      `write_file refused to overwrite ${relativePath}. Pass overwrite=true to replace it.`,
    );
  }

  const diffPreview = buildWorkspaceEditDiffPreview({
    title: relativePath,
    summary: existingStat
      ? `Overwrite ${relativePath} (${previousText.lines.length} -> ${nextText.lines.length} lines)`
      : `Create ${relativePath} (${nextText.lines.length} lines)`,
    oldLines: previousText.lines,
    newLines: nextText.lines,
  });
  const assessment: WorkspaceEditAssessment = {
    tool: "write_file",
    path: relativePath,
    summary: existingStat
      ? "Overwrite an existing workspace file"
      : "Create a new workspace file",
    reasons: [
      existingStat
        ? "full-file writes can replace existing code or configuration."
        : "creating files changes the workspace state.",
    ],
    approvalRequired: true,
    diffPreview,
  };
  const authorization = await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, args.content, "utf8");
  context?.turnEvents?.addEvent({
    kind: "workspace_edit_review",
    tool: "write_file",
    path: relativePath,
    summary: assessment.summary,
    approvalMode: authorization.approvalModeAfter,
    autoApproved:
      !authorization.prompted &&
      (authorization.approvalModeBefore === "allow-all" ||
        authorization.approvalModeBefore === "crazy_auto"),
    diffPreview,
  });

  return {
    path: relativePath,
    created: existingStat === null,
    overwritten: existingStat !== null,
    bytesWritten: Buffer.byteLength(args.content, "utf8"),
  };
}

function parseWriteFileArgs(rawArguments: string): WriteFileArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return writeFileArgsSchema.parse(parsed);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
