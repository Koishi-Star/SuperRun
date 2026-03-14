import type { WorkspaceEditDiffPreview, WorkspaceEditDiffPreviewLine } from "./types.js";

const CONTEXT_LINE_COUNT = 2;
const MAX_PREVIEW_LINES = 240;

export function buildWorkspaceEditDiffPreview(options: {
  title: string;
  summary: string;
  oldLines: string[];
  newLines: string[];
}): WorkspaceEditDiffPreview {
  const commonPrefix = countCommonPrefix(options.oldLines, options.newLines);
  const commonSuffix = countCommonSuffix(
    options.oldLines,
    options.newLines,
    commonPrefix,
  );
  const oldChangedEnd = options.oldLines.length - commonSuffix;
  const newChangedEnd = options.newLines.length - commonSuffix;
  const previewLines: WorkspaceEditDiffPreviewLine[] = [];

  appendContextLines(
    previewLines,
    options.oldLines.slice(Math.max(0, commonPrefix - CONTEXT_LINE_COUNT), commonPrefix),
    Math.max(0, commonPrefix - CONTEXT_LINE_COUNT) + 1,
    Math.max(0, commonPrefix - CONTEXT_LINE_COUNT) + 1,
  );
  appendRemovedLines(
    previewLines,
    options.oldLines.slice(commonPrefix, oldChangedEnd),
    commonPrefix + 1,
  );
  appendAddedLines(
    previewLines,
    options.newLines.slice(commonPrefix, newChangedEnd),
    commonPrefix + 1,
  );
  appendContextLines(
    previewLines,
    options.newLines.slice(newChangedEnd, Math.min(options.newLines.length, newChangedEnd + CONTEXT_LINE_COUNT)),
    newChangedEnd + 1,
    newChangedEnd + 1,
  );

  if (previewLines.length === 0) {
    previewLines.push({
      kind: "context",
      oldLineNumber: null,
      newLineNumber: null,
      text: "(no textual change)",
    });
  }

  return {
    title: options.title,
    summary: options.summary,
    truncated: previewLines.length > MAX_PREVIEW_LINES,
    lines: previewLines.slice(0, MAX_PREVIEW_LINES),
  };
}

function appendContextLines(
  output: WorkspaceEditDiffPreviewLine[],
  lines: string[],
  oldStartLine: number,
  newStartLine: number,
): void {
  for (const [index, line] of lines.entries()) {
    output.push({
      kind: "context",
      oldLineNumber: oldStartLine + index,
      newLineNumber: newStartLine + index,
      text: line,
    });
  }
}

function appendRemovedLines(
  output: WorkspaceEditDiffPreviewLine[],
  lines: string[],
  oldStartLine: number,
): void {
  for (const [index, line] of lines.entries()) {
    output.push({
      kind: "remove",
      oldLineNumber: oldStartLine + index,
      newLineNumber: null,
      text: line,
    });
  }
}

function appendAddedLines(
  output: WorkspaceEditDiffPreviewLine[],
  lines: string[],
  newStartLine: number,
): void {
  for (const [index, line] of lines.entries()) {
    output.push({
      kind: "add",
      oldLineNumber: null,
      newLineNumber: newStartLine + index,
      text: line,
    });
  }
}

function countCommonPrefix(left: string[], right: string[]): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function countCommonSuffix(
  left: string[],
  right: string[],
  commonPrefix: number,
): number {
  let index = 0;
  while (
    index < left.length - commonPrefix &&
    index < right.length - commonPrefix &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) {
    index += 1;
  }

  return index;
}
