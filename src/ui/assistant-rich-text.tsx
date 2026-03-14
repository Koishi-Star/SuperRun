import React from "react";
import chalk from "chalk";
import { Box, Text } from "ink";
import { highlight } from "cli-highlight";

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
      kind: "code_block";
      language: string | null;
      code: string;
    };

export type RichTextTone =
  | "default"
  | "assistant"
  | "info"
  | "warning"
  | "error";

export function RichText(props: {
  text: string;
  tone?: RichTextTone;
}): React.JSX.Element {
  const blocks = parseAssistantRichText(props.text);
  const tone = props.tone ?? "default";

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => renderRichTextBlock(block, index, tone))}
    </Box>
  );
}

export function AssistantRichText(props: { text: string }): React.JSX.Element {
  return <RichText text={props.text} tone="assistant" />;
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

  for (const line of lines) {
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

    if (!line.trim()) {
      blocks.push({ kind: "blank" });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const headingLevel = headingMatch[1] ?? "";
      const headingText = headingMatch[2] ?? "";
      blocks.push({
        kind: "heading",
        level: headingLevel.length,
        segments: parseInlineSegments(headingText),
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

    const unorderedListMatch = line.match(/^([-*])\s+(.*)$/);
    if (unorderedListMatch) {
      const marker = unorderedListMatch[1] ?? "-";
      const itemText = unorderedListMatch[2] ?? "";
      blocks.push({
        kind: "list_item",
        marker,
        segments: parseInlineSegments(itemText),
      });
      continue;
    }

    const orderedListMatch = line.match(/^(\d+\.)\s+(.*)$/);
    if (orderedListMatch) {
      const marker = orderedListMatch[1] ?? "1.";
      const itemText = orderedListMatch[2] ?? "";
      blocks.push({
        kind: "list_item",
        marker,
        segments: parseInlineSegments(itemText),
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
      write(`${chalk.magentaBright("│ ")}${applyToneToAnsi(highlightedLine, tone)}\n`);
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
        inCodeBlock = false;
        codeLanguage = null;
      }
    },
  };
}

function renderRichTextBlock(
  block: AssistantRichTextBlock,
  index: number,
  tone: RichTextTone,
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
    case "code_block":
      return (
        <CodeBlock
          key={`assistant-block-${index}`}
          code={block.code}
          language={block.language}
          tone={tone}
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
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color="magentaBright">```</Text>
        {props.language ? <Text color="magentaBright">{props.language}</Text> : null}
      </Box>
      {lines.length === 0 ? (
        <Box flexDirection="row">
          <Text color="magentaBright">│ </Text>
        </Box>
      ) : (
        lines.map((line, index) => (
          <Box key={`code-line-${index}`} flexDirection="row">
            <Text color="magentaBright">│ </Text>
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

function getBaseColor(tone: RichTextTone): "white" | "yellowBright" | "redBright" {
  switch (tone) {
    case "warning":
      return "yellowBright";
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
): "cyanBright" | "yellowBright" | "redBright" | "white" {
  if (tone === "warning") {
    return "yellowBright";
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
    case "code_block":
      return [
        chalk.magentaBright(`\`\`\`${block.language ?? ""}`),
        ...highlightAssistantCode(block.code, block.language)
          .split("\n")
          .map((line) => `${chalk.magentaBright("│ ")}${applyToneToAnsi(line, tone)}`),
        chalk.magentaBright("```"),
      ].join("\n");
    case "paragraph":
    default:
      return applyToneFormatter(
        formatInlineSegmentsToAnsi(block.segments, tone),
        tone,
      );
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
    nextText = chalk.yellowBright(nextText);
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
      return chalk.yellowBright(text);
    case "error":
      return chalk.redBright(text);
    case "assistant":
    case "default":
    default:
      return text;
  }
}
