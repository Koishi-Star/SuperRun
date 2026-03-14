import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { buildWorkspaceEditDiffPreview } from "./diff_preview.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { normalizeReplacementLines, readWorkspaceTextFile, writeWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

const replaceLinesArgsSchema = z.object({
  path: z.string().trim().min(1),
  start_line: z.number().int().min(1),
  end_line: z.number().int().min(1),
  content: z.string(),
});

type ReplaceLinesArgs = z.infer<typeof replaceLinesArgsSchema>;

export const replaceLinesTool = {
  definition: {
    name: "replace_lines",
    description:
      "Replace an inclusive 1-based line range in an existing UTF-8 text file. Prefer this over full-file writes when only a small section needs to change.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to update.",
        },
        start_line: {
          type: "integer",
          description: "Inclusive 1-based starting line to replace.",
          minimum: 1,
        },
        end_line: {
          type: "integer",
          description: "Inclusive 1-based ending line to replace.",
          minimum: 1,
        },
        content: {
          type: "string",
          description: "Replacement text block for the selected line range.",
        },
      },
      required: ["path", "start_line", "end_line", "content"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseReplaceLinesArgs(rawArguments);
      const result = await replaceWorkspaceLines(parsedArgs, context);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown replace_lines error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function replaceWorkspaceLines(
  args: ReplaceLinesArgs,
  context?: ToolExecutionContext,
): Promise<{
  path: string;
  startLine: number;
  endLine: number;
  insertedLineCount: number;
  totalLines: number;
}> {
  if (args.end_line < args.start_line) {
    throw new Error("replace_lines end_line must be greater than or equal to start_line.");
  }

  const relativePath = normalizeRelativeWorkspacePath("replace_lines", args.path);
  const absolutePath = resolveWorkspacePath("replace_lines", process.cwd(), relativePath);
  const file = await readWorkspaceTextFile(absolutePath, "replace_lines");

  if (file.lines.length === 0) {
    throw new Error("replace_lines cannot target an empty file. Use write_file or insert_lines instead.");
  }

  if (args.start_line > file.lines.length || args.end_line > file.lines.length) {
    throw new Error(`replace_lines range is out of bounds for ${relativePath}.`);
  }

  const replacementLines = normalizeReplacementLines(args.content);
  const nextLines = [
    ...file.lines.slice(0, args.start_line - 1),
    ...replacementLines,
    ...file.lines.slice(args.end_line),
  ];

  const assessment: WorkspaceEditAssessment = {
    tool: "replace_lines",
    path: relativePath,
    summary: `Replace lines ${args.start_line}-${args.end_line}`,
    reasons: [
      "targeted line replacement edits existing workspace content.",
    ],
    approvalRequired: true,
    diffPreview: buildWorkspaceEditDiffPreview({
      title: relativePath,
      summary: `Replace lines ${args.start_line}-${args.end_line} in ${relativePath}`,
      oldLines: file.lines,
      newLines: nextLines,
    }),
  };
  await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  await writeWorkspaceTextFile(absolutePath, {
    ...file,
    lines: nextLines,
  });

  return {
    path: relativePath,
    startLine: args.start_line,
    endLine: args.end_line,
    insertedLineCount: replacementLines.length,
    totalLines: nextLines.length,
  };
}

function parseReplaceLinesArgs(rawArguments: string): ReplaceLinesArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return replaceLinesArgsSchema.parse(parsed);
}
