import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { resolveSymbolRange, computeBodyHash, isSupportedSourceFile, getSymbolSource, resolveSymbolMemberRange, getSymbolMemberSource } from "./symbol-resolve.js";
import { buildWorkspaceEditDiffPreview } from "./diff_preview.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { normalizeReplacementLines, readWorkspaceTextFile, writeWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

const replaceSymbolBodyArgsSchema = z.object({
  path: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  member: z.string().trim().min(1).optional(),
  expected_hash: z.string().trim().min(1),
  new_body: z.string(),
});

type ReplaceSymbolBodyArgs = z.infer<typeof replaceSymbolBodyArgsSchema>;

export const replaceSymbolBodyTool = {
  definition: {
    name: "replace_symbol_body",
    description:
      "Replace the entire declaration of a named symbol, or a specific member within it (class method, nested function). Requires an expected_hash obtained from get_symbol_source to prevent edits based on stale content — if the hash does not match, the edit is rejected and the current hash + source are returned so you can retry. Use the optional `member` parameter to replace a single class method or nested function instead of the whole symbol. After a successful edit, call run_validation.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to the source file.",
        },
        symbol: {
          type: "string",
          description: "Exact name of the top-level symbol.",
        },
        member: {
          type: "string",
          description:
            "Optional. Name of a class method or nested function within the symbol to replace. When specified, only the member's range is modified and the hash must match the member (not the parent).",
        },
        expected_hash: {
          type: "string",
          description:
            "The bodyHash value from a prior get_symbol_source call. When targeting a member, use the member's bodyHash.",
        },
        new_body: {
          type: "string",
          description:
            "Complete replacement source for the symbol or member declaration.",
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

  // 1. Read the current file and resolve target range + hash.
  const file = await readWorkspaceTextFile(absolutePath, "replace_symbol_body");

  // Determine whether we're targeting a member or the whole symbol.
  const targetingMember = Boolean(args.member);
  let resolvedStartLine: number;
  let resolvedEndLine: number;
  let resolvedHash: string;
  let resolvedKind: string;
  let targetLabel: string;

  if (targetingMember) {
    const memberRange = resolveSymbolMemberRange(absolutePath, file.content, args.symbol, args.member!);
    if (!memberRange) {
      throw new Error(
        `Member "${args.member}" not found in symbol "${args.symbol}" in ${relativePath}. Use get_symbols to list available members.`,
      );
    }
    resolvedStartLine = memberRange.startLine;
    resolvedEndLine = memberRange.endLine;
    resolvedHash = memberRange.bodyHash;
    resolvedKind = memberRange.kind;
    targetLabel = `${resolvedKind} "${args.member}" in ${args.symbol}`;
  } else {
    const resolved = resolveSymbolRange(absolutePath, file.content, args.symbol);
    if (!resolved) {
      throw new Error(
        `Symbol "${args.symbol}" not found in ${relativePath}. Use get_symbols to list available symbols.`,
      );
    }
    resolvedStartLine = resolved.startLine;
    resolvedEndLine = resolved.endLine;
    resolvedHash = resolved.bodyHash;
    resolvedKind = resolved.kind;
    targetLabel = `${resolvedKind} "${args.symbol}"`;
  }

  // 2. Hash check — reject if stale.
  if (resolvedHash !== args.expected_hash) {
    // Provide current source for recovery.
    let currentSource: string;
    if (targetingMember) {
      const memberSrc = getSymbolMemberSource(absolutePath, file.content, args.symbol, args.member!);
      currentSource = memberSrc?.source ?? "(could not retrieve current source)";
    } else {
      const symbolSrc = getSymbolSource(absolutePath, file.content, args.symbol);
      currentSource = symbolSrc?.source ?? "(could not retrieve current source)";
    }
    throw new HashMismatchError(resolvedHash, currentSource);
  }

  // 3. Build replacement lines.
  const replacementLines = normalizeReplacementLines(args.new_body);
  const nextLines = [
    ...file.lines.slice(0, resolvedStartLine - 1),
    ...replacementLines,
    ...file.lines.slice(resolvedEndLine),
  ];

  // 4. Diff preview + approval (reuses existing edit policy).
  const diffPreview = buildWorkspaceEditDiffPreview({
    title: relativePath,
    summary: `Replace ${targetLabel} (lines ${resolvedStartLine}-${resolvedEndLine}) in ${relativePath}`,
    oldLines: file.lines,
    newLines: nextLines,
  });
  const assessment: WorkspaceEditAssessment = {
    tool: "replace_symbol_body",
    path: relativePath,
    summary: `Replace ${targetLabel} (lines ${resolvedStartLine}-${resolvedEndLine})`,
    reasons: [
      `Symbol-targeted replacement of ${targetLabel}.`,
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
  const newEndLine = resolvedStartLine + replacementLines.length - 1;

  return {
    path: relativePath,
    symbol: args.symbol,
    ...(args.member ? { member: args.member } : {}),
    newStartLine: resolvedStartLine,
    newEndLine: Math.max(newEndLine, resolvedStartLine),
    newHash,
    insertedLineCount: replacementLines.length,
    totalLines: nextLines.length,
  };
}

function parseReplaceSymbolBodyArgs(rawArguments: string): ReplaceSymbolBodyArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return replaceSymbolBodyArgsSchema.parse(parsed);
}
