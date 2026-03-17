import React from "react";
import chalk from "chalk";
import { Box, Text } from "ink";
import { highlight } from "cli-highlight";
import { getDisplayWidth, truncateForTerminal } from "./terminal_format.js";

export type AssistantInlineSegment =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "bold";
      text: string;
    }
  | {
      kind: "code";
      text: string;
    };

export type MarkdownTableAlignment = "left" | "center" | "right";

export type MarkdownTable = {
  headers: string[];
  rows: string[][];
  alignments: MarkdownTableAlignment[];
};

export type AssistantRichTextBlock =
  | {
      kind: "blank";
    }
  | {
      kind: "paragraph";
      segments: AssistantInlineSegment[];
    }
  | {
      kind: "heading";
      level: number;
      segments: AssistantInlineSegment[];
    }
  | {
      kind: "quote";
      segments: AssistantInlineSegment[];
    }
  | {
      kind: "list_item";
      marker: string;
      segments: AssistantInlineSegment[];
    }
  | {
      kind: "checklist_item";
      marker: " " | "x" | "~" | "!";
      segments: AssistantInlineSegment[];
    }
  | {
      kind: "code_block";
      language: string | null;
      code: string;
    }
  | {
      kind: "table";
      headers: string[];
      rows: string[][];
      alignments: MarkdownTableAlignment[];
    };

export type RichTextTone =
  | "default"
  | "assistant"
  | "info"
  | "warning"
  | "error";

const WARNING_COLOR = "#ff8c42";

export function RichText(props: {
  text: string;
  tone?: RichTextTone;
  maxWidth?: number;
}): React.JSX.Element {
  const blocks = parseAssistantRichText(props.text);
  const tone = props.tone ?? "default";

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => renderRichTextBlock(block, index, tone, props.maxWidth))}
    </Box>
  );
}

export function AssistantRichText(props: {
  text: string;
  maxWidth?: number;
}): React.JSX.Element {
  return <RichText text={props.text} tone="assistant" {...(props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : {})} />;
}

export function parseAssistantRichText(text: string): AssistantRichTextBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: AssistantRichTextBlock[] = [];
  let activeCodeBlock:
    | {
        language: string | null;
        lines: string[];
      }
    | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(/^```([\w#+.-]+)?\s*$/);
    if (fenceMatch) {
      if (activeCodeBlock) {
        blocks.push({
          kind: "code_block",
          language: activeCodeBlock.language,
          code: activeCodeBlock.lines.join("\n"),
        });
        activeCodeBlock = null;
        continue;
      }

      activeCodeBlock = {
        language: fenceMatch[1] ?? null,
        lines: [],
      };
      continue;
    }

    if (activeCodeBlock) {
      activeCodeBlock.lines.push(line);
      continue;
    }

    const tableMatch = parseMarkdownTable(lines, index);
    if (tableMatch) {
      blocks.push({
        kind: "table",
        headers: tableMatch.table.headers,
        rows: tableMatch.table.rows,
        alignments: tableMatch.table.alignments,
      });
      index = tableMatch.nextIndex - 1;
      continue;
    }

    if (!line.trim()) {
      blocks.push({ kind: "blank" });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: (headingMatch[1] ?? "").length,
        segments: parseInlineSegments(headingMatch[2] ?? ""),
      });
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      blocks.push({
        kind: "quote",
        segments: parseInlineSegments(quoteMatch[1] ?? ""),
      });
      continue;
    }

    const checklistMatch = line.match(/^[-*]\s+\[([ x~!])\]\s+(.*)$/);
    if (checklistMatch) {
      blocks.push({
        kind: "checklist_item",
        marker: (checklistMatch[1] as " " | "x" | "~" | "!") ?? " ",
        segments: parseInlineSegments(checklistMatch[2] ?? ""),
      });
      continue;
    }

    const unorderedListMatch = line.match(/^([-*])\s+(.*)$/);
    if (unorderedListMatch) {
      blocks.push({
        kind: "list_item",
        marker: unorderedListMatch[1] ?? "-",
        segments: parseInlineSegments(unorderedListMatch[2] ?? ""),
      });
      continue;
    }

    const orderedListMatch = line.match(/^(\d+\.)\s+(.*)$/);
    if (orderedListMatch) {
      blocks.push({
        kind: "list_item",
        marker: orderedListMatch[1] ?? "1.",
        segments: parseInlineSegments(orderedListMatch[2] ?? ""),
      });
      continue;
    }

    blocks.push({
      kind: "paragraph",
      segments: parseInlineSegments(line),
    });
  }

  // Streaming replies can leave a fence unclosed for a while, so render the
  // trailing content as a code block instead of dropping it.
  if (activeCodeBlock) {
    blocks.push({
      kind: "code_block",
      language: activeCodeBlock.language,
      code: activeCodeBlock.lines.join("\n"),
    });
  }

  return blocks;
}

export function parseMarkdownTable(
  lines: string[],
  startIndex: number,
): {
  table: MarkdownTable;
  nextIndex: number;
} | null {
  if (startIndex + 1 >= lines.length) {
    return null;
  }

  const headerCells = splitMarkdownTableRow(lines[startIndex] ?? "");
  const separatorCells = splitMarkdownTableRow(lines[startIndex + 1] ?? "");
  if (
    headerCells.length < 2 ||
    separatorCells.length !== headerCells.length ||
    !separatorCells.every(isMarkdownTableSeparatorCell)
  ) {
    return null;
  }

  const alignments = separatorCells.map(parseMarkdownTableAlignment);
  const rows: string[][] = [];
  let nextIndex = startIndex + 2;

  while (nextIndex < lines.length) {
    const nextCells = splitMarkdownTableRow(lines[nextIndex] ?? "");
    if (nextCells.length < 2) {
      break;
    }

    rows.push(normalizeMarkdownTableCells(nextCells, headerCells.length));
    nextIndex += 1;
  }

  return {
    table: {
      headers: normalizeMarkdownTableCells(headerCells, headerCells.length),
      rows,
      alignments,
    },
    nextIndex,
  };
}

export function renderMarkdownTableLines(
  table: MarkdownTable,
  maxWidth?: number,
): string[] {
  const columnCount = table.headers.length;
  // Natural width of each column: max(header, max row cell).
  const naturalWidths = table.headers.map((header, columnIndex) => {
    const rowWidths = table.rows.map((row) => getDisplayWidth(row[columnIndex] ?? ""));
    return Math.max(getDisplayWidth(header), ...rowWidths);
  });

  // Total width of the rendered table at natural size:
  // "| " (2) + col + (" | " between cols = 3*(n-1)) + " |" (2)
  const separatorOverhead = 2 + 2 + Math.max(0, columnCount - 1) * 3;
  const naturalTotal = naturalWidths.reduce((sum, w) => sum + w, 0) + separatorOverhead;

  let widths = naturalWidths;
  if (maxWidth !== undefined && maxWidth > 0 && naturalTotal > maxWidth) {
    // Proportionally compress columns to fit maxWidth.
    const MIN_COL_WIDTH = 4;
    const availableForColumns = Math.max(
      columnCount * MIN_COL_WIDTH,
      maxWidth - separatorOverhead,
    );
    const naturalColumnTotal = naturalWidths.reduce((sum, w) => sum + w, 0);
    widths = naturalWidths.map((w) => {
      const ratio = naturalColumnTotal > 0 ? w / naturalColumnTotal : 1 / columnCount;
      return Math.max(MIN_COL_WIDTH, Math.round(availableForColumns * ratio));
    });
    // Adjust rounding error on the last column.
    const allocated = widths.reduce((sum, w) => sum + w, 0);
    const lastIndex = widths.length - 1;
    if (lastIndex >= 0) {
      widths[lastIndex] = Math.max(MIN_COL_WIDTH, (widths[lastIndex] ?? 0) + (availableForColumns - allocated));
    }
  }

  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const headerBorder = `+${widths.map((width) => "=".repeat(width + 2)).join("+")}+`;
  const renderRow = (cells: string[]) => `| ${
    cells.map((cell, columnIndex) => padMarkdownTableCell(
      cell,
      widths[columnIndex] ?? 0,
      table.alignments[columnIndex] ?? "left",
    )).join(" | ")
  } |`;

  return [
    border,
    renderRow(table.headers),
    headerBorder,
    ...table.rows.map((row) => renderRow(row)),
    border,
  ];
}

export function parseInlineSegments(text: string): AssistantInlineSegment[] {
  const segments: AssistantInlineSegment[] = [];
  let currentText = "";
  let index = 0;

  const flushText = () => {
    if (!currentText) {
      return;
    }

    segments.push({
      kind: "text",
      text: currentText,
    });
    currentText = "";
  };

  while (index < text.length) {
    if (text.startsWith("`", index)) {
      const closingIndex = text.indexOf("`", index + 1);
      if (closingIndex > index + 1) {
        flushText();
        segments.push({
          kind: "code",
          text: text.slice(index + 1, closingIndex),
        });
        index = closingIndex + 1;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const closingIndex = text.indexOf("**", index + 2);
      if (closingIndex > index + 2) {
        flushText();
        segments.push({
          kind: "bold",
          text: text.slice(index + 2, closingIndex),
        });
        index = closingIndex + 2;
        continue;
      }
    }

    currentText += text[index];
    index += 1;
  }

  flushText();
  return segments;
}

export function highlightAssistantCode(
  code: string,
  language: string | null,
): string {
  if (!code.trim()) {
    return code;
  }

  try {
    return highlight(code, {
      ...(language ? { language } : {}),
      ignoreIllegals: true,
    });
  } catch {
    return code;
  }
}

export function formatRichTextToAnsi(
  text: string,
  tone: RichTextTone = "default",
): string {
  const blocks = parseAssistantRichText(text);
  return blocks.map((block) => formatBlockToAnsi(block, tone)).join("\n");
}

export function createAnsiRichTextStreamWriter(
  write: (text: string) => void,
  tone: RichTextTone = "default",
): {
  writeChunk: (chunk: string) => void;
  end: () => void;
} {
  let pendingLine = "";
  let inCodeBlock = false;
  let codeLanguage: string | null = null;

  const flushLine = (line: string) => {
    const fenceMatch = line.match(/^```([\w#+.-]+)?\s*$/);
    if (fenceMatch) {
      if (inCodeBlock) {
        inCodeBlock = false;
        codeLanguage = null;
        write(`${chalk.magentaBright("```")}\n`);
        return;
      }

      inCodeBlock = true;
      codeLanguage = fenceMatch[1] ?? null;
      write(`${chalk.magentaBright(`\`\`\`${codeLanguage ?? ""}`)}\n`);
      return;
    }

    if (inCodeBlock) {
      const highlightedLine = highlightAssistantCode(line, codeLanguage);
      write(`${chalk.magentaBright("| ")}${applyToneToAnsi(highlightedLine, tone)}\n`);
      return;
    }

    write(`${formatRichTextToAnsi(line, tone)}\n`);
  };

  return {
    writeChunk: (chunk) => {
      pendingLine += chunk;

      while (true) {
        const newlineIndex = pendingLine.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const nextLine = pendingLine.slice(0, newlineIndex).replace(/\r$/, "");
        pendingLine = pendingLine.slice(newlineIndex + 1);
        flushLine(nextLine);
      }
    },
    end: () => {
      if (pendingLine.length > 0) {
        flushLine(pendingLine.replace(/\r$/, ""));
        pendingLine = "";
      }

      if (inCodeBlock) {
        write(chalk.magentaBright("```"));
      }
    },
  };
}

function renderRichTextBlock(
  block: AssistantRichTextBlock,
  index: number,
  tone: RichTextTone,
  maxWidth?: number,
): React.JSX.Element {
  switch (block.kind) {
    case "blank":
      return <Text key={`assistant-block-${index}`}> </Text>;
    case "heading":
      return (
        <Text
          key={`assistant-block-${index}`}
          bold
          color={getHeadingColor(block.level, tone)}
          dimColor={tone === "info"}
        >
          {renderInlineSegments(block.segments, tone)}
        </Text>
      );
    case "quote":
      return (
        <Box key={`assistant-block-${index}`} flexDirection="row">
          <Text color="magentaBright">{"> "}</Text>
          <Text dimColor={tone === "info"} color={getBaseColor(tone)}>
            {renderInlineSegments(block.segments, tone)}
          </Text>
        </Box>
      );
    case "list_item":
      return (
        <Box key={`assistant-block-${index}`} flexDirection="row">
          <Text color="cyan">{`${block.marker} `}</Text>
          <Text dimColor={tone === "info"} color={getBaseColor(tone)}>
            {renderInlineSegments(block.segments, tone)}
          </Text>
        </Box>
      );
    case "checklist_item":
      return (
        <Box key={`assistant-block-${index}`} flexDirection="row">
          <Text color={getChecklistColor(block.marker)}>{`${formatChecklistMarker(block.marker)} `}</Text>
          <Text dimColor={tone === "info"} color={getBaseColor(tone)}>
            {renderInlineSegments(block.segments, tone)}
          </Text>
        </Box>
      );
    case "code_block":
      return (
        <CodeBlock
          key={`assistant-block-${index}`}
          code={block.code}
          language={block.language}
          tone={tone}
        />
      );
    case "table":
      return (
        <TableBlock
          key={`assistant-block-${index}`}
          table={{
            headers: block.headers,
            rows: block.rows,
            alignments: block.alignments,
          }}
          tone={tone}
          {...(maxWidth !== undefined ? { maxWidth } : {})}
        />
      );
    case "paragraph":
    default:
      return (
        <Text
          key={`assistant-block-${index}`}
          dimColor={tone === "info"}
          color={getBaseColor(tone)}
        >
          {renderInlineSegments(block.segments, tone)}
        </Text>
      );
  }
}

function renderInlineSegments(
  segments: AssistantInlineSegment[],
  tone: RichTextTone,
): React.ReactNode[] {
  return segments.map((segment, index) => {
    switch (segment.kind) {
      case "bold":
        return (
          <Text
            key={`inline-segment-${index}`}
            bold
            color={getBaseColor(tone)}
            dimColor={tone === "info"}
          >
            {segment.text}
          </Text>
        );
      case "code":
        return (
          <Text key={`inline-segment-${index}`} color="magentaBright">
            {segment.text}
          </Text>
        );
      case "text":
      default:
        return (
          <Text
            key={`inline-segment-${index}`}
            color={getBaseColor(tone)}
            dimColor={tone === "info"}
          >
            {segment.text}
          </Text>
        );
    }
  });
}

function CodeBlock(props: {
  code: string;
  language: string | null;
  tone: RichTextTone;
}): React.JSX.Element {
  const highlightedCode = highlightAssistantCode(props.code, props.language);
  const lines = highlightedCode.split("\n");

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="magentaBright">```</Text>
        {props.language ? <Text color="magentaBright">{props.language}</Text> : null}
      </Box>
      {lines.length === 0 ? (
        <Box flexDirection="row">
          <Text color="magentaBright">| </Text>
        </Box>
      ) : (
        lines.map((line, index) => (
          <Box key={`code-line-${index}`} flexDirection="row">
            <Text color="magentaBright">| </Text>
            <Text color={getBaseColor(props.tone)} dimColor={props.tone === "info"}>
              {line}
            </Text>
          </Box>
        ))
      )}
      <Text color="magentaBright">```</Text>
    </Box>
  );
}

function TableBlock(props: {
  table: MarkdownTable;
  tone: RichTextTone;
  maxWidth?: number;
}): React.JSX.Element {
  const lines = renderMarkdownTableLines(props.table, props.maxWidth);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const isBorder = index === 0 || index === 2 || index === lines.length - 1;
        const isHeader = index === 1;

        return (
          <Text
            key={`table-line-${index}`}
            color={isBorder ? "cyan" : getBaseColor(props.tone)}
            dimColor={props.tone === "info" && !isBorder}
            bold={isHeader}
          >
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

function splitMarkdownTableRow(line: string): string[] {
  if (!line.includes("|")) {
    return [];
  }

  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells: string[] = [];
  let current = "";

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    const nextCharacter = trimmed[index + 1];
    if (character === "\\" && nextCharacter === "|") {
      current += "|";
      index += 1;
      continue;
    }

    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  cells.push(current.trim());
  return cells;
}

function isMarkdownTableSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function parseMarkdownTableAlignment(cell: string): MarkdownTableAlignment {
  const trimmed = cell.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) {
    return "center";
  }
  if (trimmed.endsWith(":")) {
    return "right";
  }
  return "left";
}

function normalizeMarkdownTableCells(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => {
    const rawCell = cells[index] ?? "";
    return inlineSegmentsToPlainText(parseInlineSegments(rawCell));
  });
}

function inlineSegmentsToPlainText(segments: AssistantInlineSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

function padMarkdownTableCell(
  text: string,
  width: number,
  alignment: MarkdownTableAlignment,
): string {
  // Truncate cell content when it exceeds the (possibly compressed) column width.
  const displayText = getDisplayWidth(text) > width
    ? truncateForTerminal(text, width)
    : text;
  const gap = Math.max(0, width - getDisplayWidth(displayText));
  if (alignment === "right") {
    return `${" ".repeat(gap)}${displayText}`;
  }
  if (alignment === "center") {
    const left = Math.floor(gap / 2);
    const right = gap - left;
    return `${" ".repeat(left)}${displayText}${" ".repeat(right)}`;
  }
  return `${displayText}${" ".repeat(gap)}`;
}

function getBaseColor(tone: RichTextTone): string {
  switch (tone) {
    case "warning":
      return WARNING_COLOR;
    case "error":
      return "redBright";
    case "assistant":
    case "info":
    case "default":
    default:
      return "white";
  }
}

function getHeadingColor(
  level: number,
  tone: RichTextTone,
): string {
  if (tone === "warning") {
    return WARNING_COLOR;
  }

  if (tone === "error") {
    return "redBright";
  }

  return level <= 2 ? "cyanBright" : "white";
}

function formatBlockToAnsi(
  block: AssistantRichTextBlock,
  tone: RichTextTone,
): string {
  switch (block.kind) {
    case "blank":
      return "";
    case "heading":
      return applyToneFormatter(
        formatInlineSegmentsToAnsi(block.segments, tone),
        tone,
        true,
      );
    case "quote":
      return `${chalk.magentaBright("> ")}${applyToneFormatter(
        formatInlineSegmentsToAnsi(block.segments, tone),
        tone,
      )}`;
    case "list_item":
      return `${chalk.cyan(`${block.marker} `)}${applyToneFormatter(
        formatInlineSegmentsToAnsi(block.segments, tone),
        tone,
      )}`;
    case "checklist_item":
      return `${chalk.hex(getChecklistColor(block.marker))(formatChecklistMarker(block.marker))} ${applyToneFormatter(
        formatInlineSegmentsToAnsi(block.segments, tone),
        tone,
      )}`;
    case "code_block":
      return [
        chalk.magentaBright(`\`\`\`${block.language ?? ""}`),
        ...highlightAssistantCode(block.code, block.language)
          .split("\n")
          .map((line) => `${chalk.magentaBright("| ")}${applyToneToAnsi(line, tone)}`),
        chalk.magentaBright("```"),
      ].join("\n");
    case "table":
      return renderMarkdownTableLines({
        headers: block.headers,
        rows: block.rows,
        alignments: block.alignments,
      }, process.stdout.columns || undefined).map((line, index, lines) => {
        const isBorder = index === 0 || index === 2 || index === lines.length - 1;
        const isHeader = index === 1;
        return isBorder
          ? chalk.cyan(line)
          : applyToneFormatter(line, tone, isHeader);
      }).join("\n");
    case "paragraph":
    default:
      return applyToneFormatter(
        formatInlineSegmentsToAnsi(block.segments, tone),
        tone,
      );
  }
}

function formatChecklistMarker(marker: " " | "x" | "~" | "!"): string {
  return `[${marker}]`;
}

function getChecklistColor(marker: " " | "x" | "~" | "!"): string {
  switch (marker) {
    case "x":
      return "#2f9e44";
    case "~":
      return "#e67700";
    case "!":
      return "#c92a2a";
    default:
      return "#0891b2";
  }
}

function formatInlineSegmentsToAnsi(
  segments: AssistantInlineSegment[],
  tone: RichTextTone,
): string {
  return segments.map((segment) => {
    switch (segment.kind) {
      case "bold":
        return applyToneFormatter(segment.text, tone, true);
      case "code":
        return chalk.magentaBright(segment.text);
      case "text":
      default:
        return applyToneFormatter(segment.text, tone);
    }
  }).join("");
}

function applyToneFormatter(
  text: string,
  tone: RichTextTone,
  bold = false,
): string {
  let nextText = text;

  if (tone === "info") {
    nextText = chalk.dim(nextText);
  } else if (tone === "warning") {
    nextText = chalk.hex(WARNING_COLOR)(nextText);
  } else if (tone === "error") {
    nextText = chalk.redBright(nextText);
  }

  return bold ? chalk.bold(nextText) : nextText;
}

function applyToneToAnsi(
  text: string,
  tone: RichTextTone,
): string {
  switch (tone) {
    case "info":
      return chalk.dim(text);
    case "warning":
      return chalk.hex(WARNING_COLOR)(text);
    case "error":
      return chalk.redBright(text);
    case "assistant":
    case "default":
    default:
      return text;
  }
}
