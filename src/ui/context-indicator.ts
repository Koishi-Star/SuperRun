export type ContextIndicatorTone = "muted" | "notice" | "warning" | "critical";

export type ContextIndicatorDisplay = {
  usedTokens: number | null;
  limitTokens: number | null;
  usedText: string;
  limitText: string;
  usageText: string;
  percentText: string;
  ratio: number | null;
  tone: ContextIndicatorTone;
  isNearFull: boolean;
};

export function buildContextIndicatorDisplay(
  usedTokens: number | null,
  limitTokens: number | null,
): ContextIndicatorDisplay {
  const safeUsedTokens = usedTokens ?? 0;
  const ratio = limitTokens && limitTokens > 0
    ? Math.max(0, Math.min(safeUsedTokens / limitTokens, 1))
    : null;

  return {
    usedTokens,
    limitTokens,
    usedText: formatCompactTokenCount(usedTokens),
    limitText: formatCompactTokenCount(limitTokens),
    usageText: `${formatCompactTokenCount(usedTokens)}/${formatCompactTokenCount(limitTokens)}`,
    percentText: ratio === null ? "--%" : formatUsagePercent(ratio),
    ratio,
    tone: classifyContextIndicatorTone(ratio),
    isNearFull: ratio !== null && ratio >= 0.9,
  };
}

export function formatCompactTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "--";
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }

  return value.toString();
}

export function classifyContextIndicatorTone(
  ratio: number | null,
): ContextIndicatorTone {
  if (ratio === null || ratio < 0.5) {
    return "muted";
  }

  if (ratio < 0.75) {
    return "notice";
  }

  if (ratio < 0.9) {
    return "warning";
  }

  return "critical";
}

function formatUsagePercent(ratio: number): string {
  const rounded = Math.round(ratio * 1_000) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}
