import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { resolveSymbolRange, computeBodyHash, isSupportedSourceFile, getSymbolSource } from "./symbol-resolve.js";
import { buildWorkspaceEditDiffPreview } from "./diff_preview.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { normalizeReplacementLines, readWorkspaceTextFile, writeWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

const replaceSymbolBodyArgsSchema = z.object({
  path: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  expected_hash: z.string().trim().min(1),
  new_body: z.string(),
});

type ReplaceSymbolBodyArgs = z.infer<typeof replaceSymbolBodyArgsSchema>;

export const replaceSymbolBodyTool = {
  definition: {
    name: "replace_symbol_body",
    description:
      "Replace the entire declaration of a named symbol (function, class, interface, type, variable) with new content. Requires an expected_hash obtained from get_symbol_source to prevent edits based on stale content — if the hash does not match the current source, the edit is rejected and the current hash + source are returned so you can retry. Only the target symbol's line range is modified; surrounding code is untouched. After a successful edit, call run_validation to verify the project still compiles.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to the source file.",
        },
        symbol: {
          type: "string",
          description: "Exact name of the symbol to replace.",
        },
        expected_hash: {
          type: "string",
          description:
            "The bodyHash value from a prior get_symbol_source call. The edit is rejected if this does not match the symbol's current hash.",
        },
        new_body: {
          type: "string",
          description:
            "Complete replacement source for the symbol declaration (including keywords like export, function, const, etc.).",
        },
      },
      required: ["path", "symbol", "expected_hash", "new_body"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const args = parseReplaceSymbolBodyArgs(rawArguments);
      const result = await replaceSymbolBody(args, context);
      return JSON.stringify({ ok: true, ...result });
    } catch (error) {
      if (error instanceof HashMismatchError) {
        return JSON.stringify({
          ok: false,
          error: error.message,
          currentHash: error.currentHash,
          currentSource: error.currentSource,
        });
      }
      const message = error instanceof Error ? error.message : "Unknown replace_symbol_body error.";
      return JSON.stringify({ ok: false, error: message });
    }
  },
};

// ---------------------------------------------------------------------------
// Hash mismatch error (carries recovery info)
// ---------------------------------------------------------------------------

class HashMismatchError extends Error {
  constructor(
    public readonly currentHash: string,
    public readonly currentSource: string,
  ) {
    super(
      `expected_hash does not match the symbol's current hash (${currentHash}). ` +
      `Re-read the symbol with get_symbol_source before retrying.`,
    );
    this.name = "HashMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function replaceSymbolBody(
  args: ReplaceSymbolBodyArgs,
  context?: ToolExecutionContext,
): Promise<{
  path: string;
  symbol: string;
  newStartLine: number;
  newEndLine: number;
  newHash: string;
  insertedLineCount: number;
  totalLines: number;
}> {
  const relativePath = normalizeRelativeWorkspacePath("replace_symbol_body", args.path);
  const absolutePath = resolveWorkspacePath("replace_symbol_body", process.cwd(), relativePath);

  if (!isSupportedSourceFile(absolutePath)) {
    throw new Error("replace_symbol_body only supports TypeScript and JavaScript files.");
  }

  // 1. Read the current file and resolve symbol range + hash.
  const file = await readWorkspaceTextFile(absolutePath, "replace_symbol_body");
  const resolved = resolveSymbolRange(absolutePath, file.content, args.symbol);

  if (!resolved) {
    throw new Error(
      `Symbol "${args.symbol}" not found in ${relativePath}. Use get_symbols to list available symbols.`,
    );
  }

  // 2. Hash check — reject if stale.
  if (resolved.bodyHash !== args.expected_hash) {
    const current = getSymbolSource(absolutePath, file.content, args.symbol);
    throw new HashMismatchError(
      resolved.bodyHash,
      current?.source ?? "(could not retrieve current source)",
    );
  }

  // 3. Build replacement lines.
  const replacementLines = normalizeReplacementLines(args.new_body);
  const nextLines = [
    ...file.lines.slice(0, resolved.startLine - 1),
    ...replacementLines,
    ...file.lines.slice(resolved.endLine),
  ];

  // 4. Diff preview + approval (reuses existing edit policy).
  const diffPreview = buildWorkspaceEditDiffPreview({
    title: relativePath,
    summary: `Replace ${resolved.kind} "${args.symbol}" (lines ${resolved.startLine}-${resolved.endLine}) in ${relativePath}`,
    oldLines: file.lines,
    newLines: nextLines,
  });
  const assessment: WorkspaceEditAssessment = {
    tool: "replace_symbol_body",
    path: relativePath,
    summary: `Replace ${resolved.kind} "${args.symbol}" (lines ${resolved.startLine}-${resolved.endLine})`,
    reasons: [
      `Symbol-targeted replacement of ${resolved.kind} "${args.symbol}".`,
    ],
    approvalRequired: true,
    diffPreview,
  };
  const authorization = await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  // 5. Write the file.
  await writeWorkspaceTextFile(absolutePath, {
    ...file,
    lines: nextLines,
  });

  // 6. Record turn event.
  context?.turnEvents?.addEvent({
    kind: "workspace_edit_review",
    tool: "replace_symbol_body",
    path: relativePath,
    summary: assessment.summary,
    approvalMode: authorization.approvalModeAfter,
    autoApproved:
      !authorization.prompted &&
      (authorization.approvalModeBefore === "allow-all" ||
        authorization.approvalModeBefore === "crazy_auto"),
    diffPreview,
  });

  // 7. Compute new hash from the replacement text.
  const newHash = computeBodyHash(args.new_body.trim());
  const newEndLine = resolved.startLine + replacementLines.length - 1;

  return {
    path: relativePath,
    symbol: args.symbol,
    newStartLine: resolved.startLine,
    newEndLine: Math.max(newEndLine, resolved.startLine),
    newHash,
    insertedLineCount: replacementLines.length,
    totalLines: nextLines.length,
  };
}

function parseReplaceSymbolBodyArgs(rawArguments: string): ReplaceSymbolBodyArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return replaceSymbolBodyArgsSchema.parse(parsed);
}
