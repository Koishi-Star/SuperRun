export type TranscriptViewportSlice = {
  lines: string[];
  output: string;
  totalLines: number;
  viewportHeight: number;
  scrollOffsetLines: number;
  maxScrollOffsetLines: number;
  hiddenAboveLines: number;
  hiddenBelowLines: number;
};

export type TranscriptViewportItemSlice<T> = {
  items: T[];
  totalLines: number;
  viewportHeight: number;
  scrollOffsetLines: number;
  maxScrollOffsetLines: number;
  hiddenAboveLines: number;
  hiddenBelowLines: number;
};

const BLANK_LINE = " ";

// This module is the single anti-jitter boundary for the live transcript.
// Long output must be clipped here into a fixed-height window rather than by
// letting outer shell containers grow and trying to patch the resulting churn.
export function sliceTranscriptOutput(
  renderedOutput: string,
  viewportHeight: number,
  scrollOffsetLines: number,
  followLatest: boolean,
): TranscriptViewportSlice {
  const safeViewportHeight = Math.max(1, Math.floor(viewportHeight) || 1);
  const sourceLines = normalizeRenderedLines(renderedOutput);
  const baseSlice = sliceTranscriptItems(
    sourceLines,
    safeViewportHeight,
    scrollOffsetLines,
    followLatest,
  );
  const renderedLines = applyViewportHints(
    baseSlice.items,
    safeViewportHeight,
    baseSlice.hiddenAboveLines,
    baseSlice.hiddenBelowLines,
  );

  return {
    lines: renderedLines,
    output: renderedLines.join("\n"),
    totalLines: baseSlice.totalLines,
    viewportHeight: baseSlice.viewportHeight,
    scrollOffsetLines: baseSlice.scrollOffsetLines,
    maxScrollOffsetLines: baseSlice.maxScrollOffsetLines,
    hiddenAboveLines: baseSlice.hiddenAboveLines,
    hiddenBelowLines: baseSlice.hiddenBelowLines,
  };
}

export function sliceTranscriptItems<T>(
  items: T[],
  viewportHeight: number,
  scrollOffsetLines: number,
  followLatest: boolean,
): TranscriptViewportItemSlice<T> {
  const safeViewportHeight = Math.max(1, Math.floor(viewportHeight) || 1);
  const totalLines = items.length;
  const maxScrollOffsetLines = Math.max(0, totalLines - safeViewportHeight);
  const normalizedOffset = followLatest
    ? maxScrollOffsetLines
    : clamp(scrollOffsetLines, 0, maxScrollOffsetLines);
  const windowEnd = Math.min(totalLines, normalizedOffset + safeViewportHeight);

  return {
    items: items.slice(normalizedOffset, windowEnd),
    totalLines,
    viewportHeight: safeViewportHeight,
    scrollOffsetLines: normalizedOffset,
    maxScrollOffsetLines,
    hiddenAboveLines: normalizedOffset,
    hiddenBelowLines: Math.max(0, totalLines - windowEnd),
  };
}

function normalizeRenderedLines(renderedOutput: string): string[] {
  if (!renderedOutput) {
    return [];
  }

  const normalized = renderedOutput.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function applyViewportHints(
  visibleLines: string[],
  viewportHeight: number,
  hiddenAboveLines: number,
  hiddenBelowLines: number,
): string[] {
  const lines = [...visibleLines];
  const hasAboveHint = hiddenAboveLines > 0;
  const hasBelowHint = hiddenBelowLines > 0;

  while (lines.length < viewportHeight) {
    lines.push(BLANK_LINE);
  }

  if (!hasAboveHint && !hasBelowHint) {
    return lines;
  }

  if (viewportHeight === 1) {
    return [buildCombinedHint(hiddenAboveLines, hiddenBelowLines)];
  }

  if (hasAboveHint) {
    lines[0] = buildAboveHint(hiddenAboveLines);
  }

  if (hasBelowHint) {
    lines[viewportHeight - 1] = buildBelowHint(hiddenBelowLines);
  }

  return lines;
}

function buildAboveHint(hiddenAboveLines: number): string {
  return `^ ${hiddenAboveLines} earlier line${hiddenAboveLines === 1 ? "" : "s"}`;
}

function buildBelowHint(hiddenBelowLines: number): string {
  return `v ${hiddenBelowLines} newer line${hiddenBelowLines === 1 ? "" : "s"}`;
}

function buildCombinedHint(
  hiddenAboveLines: number,
  hiddenBelowLines: number,
): string {
  if (hiddenAboveLines > 0 && hiddenBelowLines > 0) {
    return `^ ${hiddenAboveLines}  v ${hiddenBelowLines}`;
  }

  if (hiddenAboveLines > 0) {
    return buildAboveHint(hiddenAboveLines);
  }

  return buildBelowHint(hiddenBelowLines);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
