/**
 * Symbol-anchored insertion tools.
 *
 * insert_before_symbol — insert new top-level code immediately before a named symbol.
 * insert_after_symbol  — insert new top-level code immediately after a named symbol.
 *
 * Both require an expected_hash to verify the anchor symbol has not changed
 * since the model last read it.  The insertion point is always at a symbol
 * boundary — never inside a declaration — which prevents the class of errors
 * where line-based inserts accidentally land inside a function body or between
 * a destructured pattern and its continuation.
 */

import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { resolveSymbolRange, computeBodyHash, isSupportedSourceFile, getSymbolSource, resolveSymbolMemberRange, getSymbolMemberSource } from "./symbol-resolve.js";
import { buildWorkspaceEditDiffPreview } from "./diff_preview.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { normalizeReplacementLines, readWorkspaceTextFile, writeWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

// ---------------------------------------------------------------------------
// Shared arg schema & hash-mismatch error
// ---------------------------------------------------------------------------

const insertNearSymbolArgsSchema = z.object({
  path: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  member: z.string().trim().min(1).optional(),
  expected_hash: z.string().trim().min(1),
  content: z.string(),
});

type InsertNearSymbolArgs = z.infer<typeof insertNearSymbolArgsSchema>;

class HashMismatchError extends Error {
  constructor(
    public readonly currentHash: string,
    public readonly currentSource: string,
  ) {
    super(
      `expected_hash does not match the anchor symbol's current hash (${currentHash}). ` +
      `Re-read the symbol with get_symbol_source before retrying.`,
    );
    this.name = "HashMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Shared insertion logic
// ---------------------------------------------------------------------------

type InsertPosition = "before" | "after";

async function insertNearSymbol(
  position: InsertPosition,
  args: InsertNearSymbolArgs,
  context?: ToolExecutionContext,
): Promise<{
  path: string;
  anchorSymbol: string;
  insertedAtLine: number;
  insertedLineCount: number;
  totalLines: number;
}> {
  const toolName = position === "before" ? "insert_before_symbol" : "insert_after_symbol";
  const relativePath = normalizeRelativeWorkspacePath(toolName, args.path);
  const absolutePath = resolveWorkspacePath(toolName, process.cwd(), relativePath);

  if (!isSupportedSourceFile(absolutePath)) {
    throw new Error(`${toolName} only supports TypeScript and JavaScript files.`);
  }

  // 1. Read the current file and resolve the anchor.
  const file = await readWorkspaceTextFile(absolutePath, toolName);

  const targetingMember = Boolean(args.member);
  let anchorStartLine: number;
  let anchorEndLine: number;
  let anchorHash: string;
  let anchorKind: string;
  let anchorLabel: string;

  if (targetingMember) {
    const memberRange = resolveSymbolMemberRange(absolutePath, file.content, args.symbol, args.member!);
    if (!memberRange) {
      throw new Error(
        `Member "${args.member}" not found in symbol "${args.symbol}" in ${relativePath}. Use get_symbols to list available members.`,
      );
    }
    anchorStartLine = memberRange.startLine;
    anchorEndLine = memberRange.endLine;
    anchorHash = memberRange.bodyHash;
    anchorKind = memberRange.kind;
    anchorLabel = `${anchorKind} "${args.member}" in ${args.symbol}`;
  } else {
    const resolved = resolveSymbolRange(absolutePath, file.content, args.symbol);
    if (!resolved) {
      throw new Error(
        `Symbol "${args.symbol}" not found in ${relativePath}. Use get_symbols to list available symbols.`,
      );
    }
    anchorStartLine = resolved.startLine;
    anchorEndLine = resolved.endLine;
    anchorHash = resolved.bodyHash;
    anchorKind = resolved.kind;
    anchorLabel = `${anchorKind} "${args.symbol}"`;
  }

  // 2. Hash check — reject if anchor has drifted.
  if (anchorHash !== args.expected_hash) {
    let currentSource: string;
    if (targetingMember) {
      const memberSrc = getSymbolMemberSource(absolutePath, file.content, args.symbol, args.member!);
      currentSource = memberSrc?.source ?? "(could not retrieve current source)";
    } else {
      const symbolSrc = getSymbolSource(absolutePath, file.content, args.symbol);
      currentSource = symbolSrc?.source ?? "(could not retrieve current source)";
    }
    throw new HashMismatchError(anchorHash, currentSource);
  }

  // 3. Compute insertion point and build new file lines.
  const insertionLines = normalizeReplacementLines(args.content);

  // "before" → insert just before the anchor's start line.
  // "after"  → insert just after the anchor's end line.
  const insertAtIndex =
    position === "before" ? anchorStartLine - 1 : anchorEndLine;

  // Ensure a blank line separates the new code from adjacent code.
  const linesWithSeparator = ensureBlankLineSeparation(
    file.lines,
    insertAtIndex,
    insertionLines,
    position,
  );

  const nextLines = [
    ...file.lines.slice(0, insertAtIndex),
    ...linesWithSeparator,
    ...file.lines.slice(insertAtIndex),
  ];

  // 4. Diff preview + approval.
  const positionLabel = position === "before" ? "before" : "after";
  const summary = `Insert ${insertionLines.length} line(s) ${positionLabel} ${anchorLabel} in ${relativePath}`;

  const diffPreview = buildWorkspaceEditDiffPreview({
    title: relativePath,
    summary,
    oldLines: file.lines,
    newLines: nextLines,
  });

  const assessment: WorkspaceEditAssessment = {
    tool: position === "before" ? "insert_before_symbol" : "insert_after_symbol",
    path: relativePath,
    summary,
    reasons: [
      `Symbol-anchored insertion ${positionLabel} ${anchorLabel}.`,
    ],
    approvalRequired: true,
    diffPreview,
  };

  const authorization = await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

  // 5. Write.
  await writeWorkspaceTextFile(absolutePath, { ...file, lines: nextLines });

  // 6. Turn event.
  context?.turnEvents?.addEvent({
    kind: "workspace_edit_review",
    tool: assessment.tool,
    path: relativePath,
    summary,
    approvalMode: authorization.approvalModeAfter,
    autoApproved:
      !authorization.prompted &&
      (authorization.approvalModeBefore === "allow-all" ||
        authorization.approvalModeBefore === "crazy_auto"),
    diffPreview,
  });

  // The "inserted at line" is 1-indexed for the model.
  const insertedAtLine = insertAtIndex + 1;

  return {
    path: relativePath,
    anchorSymbol: args.symbol,
    insertedAtLine,
    insertedLineCount: linesWithSeparator.length,
    totalLines: nextLines.length,
  };
}

/**
 * Ensure a blank-line boundary between the inserted block and neighboring code.
 * Avoids jamming a new function directly against the anchor's declaration.
 */
function ensureBlankLineSeparation(
  existingLines: string[],
  insertAtIndex: number,
  newLines: string[],
  position: InsertPosition,
): string[] {
  const result = [...newLines];

  if (position === "before") {
    // If the line before the anchor is not blank (and exists), prepend a blank line.
    const lineBefore = existingLines[insertAtIndex - 1];
    if (lineBefore !== undefined && lineBefore.trim() !== "") {
      result.unshift("");
    }
    // Ensure a blank line after the inserted block (before the anchor).
    const lineAtAnchor = existingLines[insertAtIndex];
    if (lineAtAnchor !== undefined && lineAtAnchor.trim() !== "" && result[result.length - 1]?.trim() !== "") {
      result.push("");
    }
  } else {
    // "after": ensure blank line between anchor's last line and new block.
    const lineAfterAnchor = existingLines[insertAtIndex - 1]; // endLine (1-indexed) → index endLine-1
    if (lineAfterAnchor !== undefined && lineAfterAnchor.trim() !== "" && result[0]?.trim() !== "") {
      result.unshift("");
    }
    // Ensure blank line after new block if code follows.
    const lineFollowing = existingLines[insertAtIndex];
    if (lineFollowing !== undefined && lineFollowing.trim() !== "" && result[result.length - 1]?.trim() !== "") {
      result.push("");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

function parseInsertNearSymbolArgs(rawArguments: string): InsertNearSymbolArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return insertNearSymbolArgsSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Tool: insert_before_symbol
// ---------------------------------------------------------------------------

export const insertBeforeSymbolTool = {
  definition: {
    name: "insert_before_symbol",
    description:
      "Insert new code immediately before a named symbol or a member within it. The anchor is identified by name and verified by expected_hash. Use the optional `member` parameter to anchor to a class method or nested function. The insertion lands at a symbol boundary — never inside a declaration. After inserting, call run_validation.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to the source file.",
        },
        symbol: {
          type: "string",
          description: "Exact name of the top-level anchor symbol.",
        },
        member: {
          type: "string",
          description: "Optional. Name of a class method or nested function within the symbol to anchor to.",
        },
        expected_hash: {
          type: "string",
          description:
            "The bodyHash of the anchor from a prior get_symbol_source call. When targeting a member, use the member's bodyHash.",
        },
        content: {
          type: "string",
          description:
            "The code to insert. Will be placed on its own lines immediately before the anchor.",
        },
      },
      required: ["path", "symbol", "expected_hash", "content"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const args = parseInsertNearSymbolArgs(rawArguments);
      const result = await insertNearSymbol("before", args, context);
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
      const message = error instanceof Error ? error.message : "Unknown insert_before_symbol error.";
      return JSON.stringify({ ok: false, error: message });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: insert_after_symbol
// ---------------------------------------------------------------------------

export const insertAfterSymbolTool = {
  definition: {
    name: "insert_after_symbol",
    description:
      "Insert new code immediately after a named symbol or a member within it. The anchor is identified by name and verified by expected_hash. Use the optional `member` parameter to anchor to a class method or nested function. The insertion lands at a symbol boundary — never inside a declaration. After inserting, call run_validation.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative workspace path to the source file.",
        },
        symbol: {
          type: "string",
          description: "Exact name of the top-level anchor symbol.",
        },
        member: {
          type: "string",
          description: "Optional. Name of a class method or nested function within the symbol to anchor to.",
        },
        expected_hash: {
          type: "string",
          description:
            "The bodyHash of the anchor from a prior get_symbol_source call. When targeting a member, use the member's bodyHash.",
        },
        content: {
          type: "string",
          description:
            "The code to insert. Will be placed on its own lines immediately after the anchor.",
        },
      },
      required: ["path", "symbol", "expected_hash", "content"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const args = parseInsertNearSymbolArgs(rawArguments);
      const result = await insertNearSymbol("after", args, context);
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
      const message = error instanceof Error ? error.message : "Unknown insert_after_symbol error.";
      return JSON.stringify({ ok: false, error: message });
    }
  },
};
