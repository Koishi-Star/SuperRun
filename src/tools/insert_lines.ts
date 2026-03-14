import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { buildWorkspaceEditDiffPreview } from "./diff_preview.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { normalizeReplacementLines, readWorkspaceTextFile, writeWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

const insertLinesArgsSchema = z.object({
  path: z.string().trim().min(1),
  before_line: z.number().int().min(1),
  content: z.string(),
});

type InsertLinesArgs = z.infer<typeof insertLinesArgsSchema>;

export const insertLinesTool = {
  definition: {
    name: "insert_lines",
    description:
      "Insert lines before a 1-based line number in an existing UTF-8 text file. Use before_line = total_lines + 1 to append.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to update.",
        },
        before_line: {
          type: "integer",
          description: "Insert before this 1-based line number. Use total_lines + 1 to append.",
          minimum: 1,
        },
        content: {
          type: "string",
          description: "Text block to insert before the target line.",
        },
      },
      required: ["path", "before_line", "content"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseInsertLinesArgs(rawArguments);
      const result = await insertWorkspaceLines(parsedArgs, context);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown insert_lines error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function insertWorkspaceLines(
  args: InsertLinesArgs,
  context?: ToolExecutionContext,
): Promise<{
  path: string;
  beforeLine: number;
  insertedLineCount: number;
  totalLines: number;
}> {
  const relativePath = normalizeRelativeWorkspacePath("insert_lines", args.path);
  const absolutePath = resolveWorkspacePath("insert_lines", process.cwd(), relativePath);
  const file = await readWorkspaceTextFile(absolutePath, "insert_lines");
  const maxBeforeLine = file.lines.length + 1;

  if (args.before_line > maxBeforeLine) {
    throw new Error(
      `insert_lines before_line must be between 1 and ${maxBeforeLine} for ${relativePath}.`,
    );
  }

  const insertedLines = normalizeReplacementLines(args.content);
  const insertionIndex = args.before_line - 1;
  const nextLines = [
    ...file.lines.slice(0, insertionIndex),
    ...insertedLines,
    ...file.lines.slice(insertionIndex),
  ];

  const diffPreview = buildWorkspaceEditDiffPreview({
    title: relativePath,
    summary: `Insert ${insertedLines.length} line${insertedLines.length === 1 ? "" : "s"} before line ${args.before_line} in ${relativePath}`,
    oldLines: file.lines,
    newLines: nextLines,
  });
  const assessment: WorkspaceEditAssessment = {
    tool: "insert_lines",
    path: relativePath,
    summary: `Insert lines before line ${args.before_line}`,
    reasons: [
      "targeted line insertion edits existing workspace content.",
    ],
    approvalRequired: true,
    diffPreview,
  };
  const authorization = await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  await writeWorkspaceTextFile(absolutePath, {
    ...file,
    lines: nextLines,
    // Appending to an empty file should still produce a valid line-oriented file.
    trailingNewline: file.trailingNewline || nextLines.length > 0,
  });
  context?.turnEvents?.addEvent({
    kind: "workspace_edit_review",
    tool: "insert_lines",
    path: relativePath,
    summary: assessment.summary,
    approvalMode: authorization.approvalModeAfter,
    autoApproved: !authorization.prompted && authorization.approvalModeBefore === "allow-all",
    diffPreview,
  });

  return {
    path: relativePath,
    beforeLine: args.before_line,
    insertedLineCount: insertedLines.length,
    totalLines: nextLines.length,
  };
}

function parseInsertLinesArgs(rawArguments: string): InsertLinesArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return insertLinesArgsSchema.parse(parsed);
}
