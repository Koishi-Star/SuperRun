/**
 * apply_patch — context-diff-based safe text modification tool.
 *
 * The model submits a patch describing "what the file should look like now"
 * and "what it should look like after".  The tool verifies each hunk's
 * context lines exist in the file before applying, and fails atomically
 * if any context doesn't match — preventing blind or drifted edits.
 *
 * Patch format (one or more file updates):
 *
 *   *** Begin Patch
 *   *** Update File: <relative-path>
 *   @@
 *    context line (unchanged)
 *   -old line (to remove)
 *   +new line (to add)
 *    context line (unchanged)
 *   *** End Patch
 *
 * Lines prefixed with ' ' (space) are context — they must match the file.
 * Lines prefixed with '-' are removed, '+' are added.
 * Multiple @@-hunks and multiple file updates are supported in one patch.
 */

import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import { buildWorkspaceEditDiffPreview } from "./diff_preview.js";
import { authorizeWorkspaceEdit } from "./edit_policy.js";
import { readWorkspaceTextFile, writeWorkspaceTextFile } from "./text_file.js";
import type { ToolExecutionContext, WorkspaceEditAssessment } from "./types.js";
import { normalizeRelativeWorkspacePath, resolveWorkspacePath } from "./workspace.js";

// ---------------------------------------------------------------------------
// Arg schema
// ---------------------------------------------------------------------------

const applyPatchArgsSchema = z.object({
  patch: z.string().min(1),
});

type ApplyPatchArgs = z.infer<typeof applyPatchArgsSchema>;

// ---------------------------------------------------------------------------
// Patch parsing types
// ---------------------------------------------------------------------------

type PatchHunkLine =
  | { kind: "context"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

type PatchHunk = {
  lines: PatchHunkLine[];
};

type PatchFileUpdate = {
  path: string;
  hunks: PatchHunk[];
};

type ParsedPatch = {
  files: PatchFileUpdate[];
};

// ---------------------------------------------------------------------------
// Patch parser
// ---------------------------------------------------------------------------

function parsePatch(raw: string): ParsedPatch {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const files: PatchFileUpdate[] = [];
  let currentFile: PatchFileUpdate | null = null;
  let currentHunk: PatchHunk | null = null;
  let started = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "*** Begin Patch") {
      started = true;
      continue;
    }

    if (trimmed === "*** End Patch") {
      break;
    }

    if (!started) continue;

    // *** Update File: path/to/file
    const updateMatch = trimmed.match(/^\*\*\*\s+Update File:\s*(.+)$/);
    if (updateMatch) {
      // Finalize previous hunk/file.
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
      }
      currentHunk = null;
      currentFile = { path: updateMatch[1]!.trim(), hunks: [] };
      files.push(currentFile);
      continue;
    }

    // @@ starts a new hunk.
    if (trimmed === "@@") {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
      }
      currentHunk = { lines: [] };
      continue;
    }

    // Inside a hunk: parse diff lines.
    if (currentHunk && line !== undefined) {
      if (line.startsWith("-")) {
        currentHunk.lines.push({ kind: "remove", text: line.slice(1) });
      } else if (line.startsWith("+")) {
        currentHunk.lines.push({ kind: "add", text: line.slice(1) });
      } else if (line.startsWith(" ") || line === "") {
        // Context line — strip leading space.
        currentHunk.lines.push({ kind: "context", text: line.length > 0 ? line.slice(1) : "" });
      } else {
        // Tolerate lines that don't have a prefix (treat as context).
        currentHunk.lines.push({ kind: "context", text: line });
      }
    }
  }

  // Finalize last hunk/file.
  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }

  if (files.length === 0) {
    throw new Error(
      "Could not parse any file updates from the patch. " +
      "Expected format: *** Begin Patch / *** Update File: <path> / @@ / ... / *** End Patch",
    );
  }

  return { files };
}

// ---------------------------------------------------------------------------
// Hunk application
// ---------------------------------------------------------------------------

/**
 * Apply a single hunk to file lines.
 * Returns null if the context doesn't match (the hunk cannot be applied).
 */
function applyHunk(
  fileLines: string[],
  hunk: PatchHunk,
  searchStart: number,
): { resultLines: string[]; nextSearchStart: number } | null {
  // Build the "old" pattern from context + remove lines (in order).
  const oldPattern: string[] = [];
  for (const hl of hunk.lines) {
    if (hl.kind === "context" || hl.kind === "remove") {
      oldPattern.push(hl.text);
    }
  }

  if (oldPattern.length === 0) {
    // Pure insertion (no context or removals) — insert at searchStart.
    const newLines: string[] = [];
    for (const hl of hunk.lines) {
      if (hl.kind === "add") newLines.push(hl.text);
    }
    const resultLines = [
      ...fileLines.slice(0, searchStart),
      ...newLines,
      ...fileLines.slice(searchStart),
    ];
    return { resultLines, nextSearchStart: searchStart + newLines.length };
  }

  // Find the old pattern in fileLines starting from searchStart.
  const matchIndex = findPatternInLines(fileLines, oldPattern, searchStart);
  if (matchIndex === -1) return null;

  // Build the replacement block from context + add lines.
  const replacement: string[] = [];
  for (const hl of hunk.lines) {
    if (hl.kind === "context" || hl.kind === "add") {
      replacement.push(hl.text);
    }
  }

  const resultLines = [
    ...fileLines.slice(0, matchIndex),
    ...replacement,
    ...fileLines.slice(matchIndex + oldPattern.length),
  ];

  return {
    resultLines,
    nextSearchStart: matchIndex + replacement.length,
  };
}

/**
 * Find a sequence of lines (pattern) within fileLines starting at startIndex.
 * Returns the index of the first match or -1.
 */
function findPatternInLines(
  fileLines: string[],
  pattern: string[],
  startIndex: number,
): number {
  const maxStart = fileLines.length - pattern.length;
  for (let i = startIndex; i <= maxStart; i++) {
    let matched = true;
    for (let j = 0; j < pattern.length; j++) {
      if (fileLines[i + j] !== pattern[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const applyPatchTool = {
  definition: {
    name: "apply_patch",
    description:
      "Apply a context-diff patch to one or more workspace files. Each hunk specifies " +
      "context lines (prefixed with space) that must match the file, lines to remove " +
      "(prefixed with -), and lines to add (prefixed with +). The patch is verified " +
      "against actual file contents before applying — if any context line doesn't match, " +
      "the entire patch fails without modifying the file. This is the safest way to make " +
      "targeted edits when you can describe the surrounding context. Supports multiple " +
      "file updates and multiple hunks per file in a single patch.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "The patch to apply. Format:\n" +
            "*** Begin Patch\n" +
            "*** Update File: <relative-path>\n" +
            "@@\n" +
            " context line\n" +
            "-line to remove\n" +
            "+line to add\n" +
            " context line\n" +
            "*** End Patch\n\n" +
            "Multiple @@ hunks and *** Update File sections are supported.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const args = parseApplyPatchArgs(rawArguments);
      const results = await applyPatch(args, context);
      return JSON.stringify({ ok: true, files: results });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown apply_patch error.";
      return JSON.stringify({ ok: false, error: message });
    }
  },
};

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

type ApplyPatchFileResult = {
  path: string;
  hunksApplied: number;
  totalLines: number;
};

async function applyPatch(
  args: ApplyPatchArgs,
  context?: ToolExecutionContext,
): Promise<ApplyPatchFileResult[]> {
  const parsed = parsePatch(args.patch);
  const results: ApplyPatchFileResult[] = [];

  for (const fileUpdate of parsed.files) {
    const relativePath = normalizeRelativeWorkspacePath("apply_patch", fileUpdate.path);
    const absolutePath = resolveWorkspacePath("apply_patch", process.cwd(), relativePath);

    const file = await readWorkspaceTextFile(absolutePath, "apply_patch");
    let currentLines = [...file.lines];
    let searchStart = 0;
    let hunksApplied = 0;

    for (let hi = 0; hi < fileUpdate.hunks.length; hi++) {
      const hunk = fileUpdate.hunks[hi]!;
      const result = applyHunk(currentLines, hunk, searchStart);
      if (!result) {
        // Build a diagnostic message showing which context didn't match.
        const contextLines = hunk.lines
          .filter((l) => l.kind === "context" || l.kind === "remove")
          .map((l) => l.text);
        const preview = contextLines.slice(0, 3).map((l) => `  ${l}`).join("\n");
        throw new Error(
          `apply_patch failed on ${relativePath}, hunk ${hi + 1}: context mismatch.\n` +
          `Expected to find:\n${preview}\n` +
          `Starting from line ${searchStart + 1}. The file may have been modified since you last read it.`,
        );
      }
      currentLines = result.resultLines;
      searchStart = result.nextSearchStart;
      hunksApplied++;
    }

    // Diff preview + approval.
    const diffPreview = buildWorkspaceEditDiffPreview({
      title: relativePath,
      summary: `apply_patch: ${hunksApplied} hunk(s) in ${relativePath}`,
      oldLines: file.lines,
      newLines: currentLines,
    });
    const assessment: WorkspaceEditAssessment = {
      tool: "apply_patch",
      path: relativePath,
      summary: `apply_patch: ${hunksApplied} hunk(s) in ${relativePath}`,
      reasons: [`Context-verified patch with ${hunksApplied} hunk(s).`],
      approvalRequired: true,
      diffPreview,
    };
    const authorization = await authorizeWorkspaceEdit(assessment, context?.workspaceEditPolicy);

    // Write.
    await writeWorkspaceTextFile(absolutePath, { ...file, lines: currentLines });

    // Turn event.
    context?.turnEvents?.addEvent({
      kind: "workspace_edit_review",
      tool: "apply_patch",
      path: relativePath,
      summary: assessment.summary,
      approvalMode: authorization.approvalModeAfter,
      autoApproved:
        !authorization.prompted &&
        (authorization.approvalModeBefore === "allow-all" ||
          authorization.approvalModeBefore === "crazy_auto"),
      diffPreview,
    });

    context?.notices?.addNotice?.({
      level: "info",
      message: `apply_patch applied ${hunksApplied} hunk(s) to ${relativePath}`,
    });

    results.push({
      path: relativePath,
      hunksApplied,
      totalLines: currentLines.length,
    });
  }

  return results;
}

function parseApplyPatchArgs(rawArguments: string): ApplyPatchArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return applyPatchArgsSchema.parse(parsed);
}
