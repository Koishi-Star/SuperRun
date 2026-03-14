import React from "react";
import { Box, Text, useInput, type Key } from "ink";
import { AssistantRichText, RichText } from "../assistant-rich-text.js";
import type { ComposerState } from "../composer-state.js";
import type {
  RendererLine,
  RendererOverlay,
  RendererPickerOverlay,
  RendererPrompt,
} from "../interactive-renderer.js";

export type InteractiveShellProps = {
  headerLines: RendererLine[];
  logLines: RendererLine[];
  prompt: RendererPrompt;
  divider: string;
  inputEnabled?: boolean;
  inputMode: "inactive" | "prompt" | "overlay";
  overlay: RendererOverlay | null;
  statusText: string;
  onInput: (input: string, key: Key) => void;
};

export function InteractiveShell(props: InteractiveShellProps): React.JSX.Element {
  useInput(
    (input, key) => {
      props.onInput(input, key);
    },
    { isActive: (props.inputEnabled ?? true) && props.inputMode !== "inactive" },
  );

  return (
    <Box flexDirection="column">
      <HeaderRegion lines={props.headerLines} />
      <LogRegion lines={props.logLines} />
      {props.overlay ? <OverlayPicker overlay={props.overlay} /> : null}
      <Composer
        prompt={props.prompt}
        divider={props.divider}
        inputMode={props.inputMode}
      />
      <StatusBar text={props.statusText} />
    </Box>
  );
}

function HeaderRegion(props: { lines: RendererLine[] }): React.JSX.Element {
  return <LineBlock lines={props.lines} />;
}

function LogRegion(props: { lines: RendererLine[] }): React.JSX.Element {
  return <LineBlock lines={props.lines} />;
}

function LineBlock(props: { lines: RendererLine[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.lines.map((line) => (
        <StyledLine key={line.id} line={line} />
      ))}
    </Box>
  );
}

function Composer(props: {
  prompt: RendererPrompt;
  divider: string;
  inputMode: InteractiveShellProps["inputMode"];
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>{props.divider}</Text>
      <PromptLine
        label={props.prompt.label}
        state={props.prompt.state}
        isActive={props.inputMode === "prompt"}
      />
      {props.prompt.state.errorMessage ? (
        <Text color="redBright">{`  ${props.prompt.state.errorMessage}`}</Text>
      ) : null}
      {renderSuggestionLines(props.prompt.state).map((line, index) => (
        <Text
          key={`suggestion-${line.text}-${index}`}
          dimColor={!line.selected}
          inverse={line.selected}
        >
          {line.text}
        </Text>
      ))}
      <Text dimColor>{props.divider}</Text>
    </Box>
  );
}

function PromptLine(props: {
  label: RendererPrompt["label"];
  state: ComposerState;
  isActive: boolean;
}): React.JSX.Element {
  const beforeCursor = props.state.buffer.slice(0, props.state.cursorIndex);
  const cursorCharacter = props.state.buffer.slice(
    props.state.cursorIndex,
    props.state.cursorIndex + 1,
  );
  const afterCursor = cursorCharacter
    ? props.state.buffer.slice(props.state.cursorIndex + cursorCharacter.length)
    : "";

  return (
    <Box flexDirection="row">
      <Text bold color={props.label.kind === "editor" ? "yellow" : "cyan"}>
        {props.label.text}
      </Text>
      {props.isActive
        ? (
            <Text>
              {beforeCursor}
            </Text>
          )
        : <Text>{props.state.buffer}</Text>}
      {props.isActive ? <Text inverse>{cursorCharacter || " "}</Text> : null}
      {props.isActive ? <Text>{afterCursor}</Text> : null}
    </Box>
  );
}

function OverlayPicker(props: { overlay: RendererOverlay }): React.JSX.Element {
  if (props.overlay.kind === "diff") {
    return <DiffApprovalOverlay overlay={props.overlay} />;
  }

  const overlay = props.overlay;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      marginTop={1}
      paddingX={1}
      paddingY={0}
    >
      <RichText text={overlay.title} />
      {overlay.subtitle ? <RichText text={overlay.subtitle} tone="info" /> : null}
      {overlay.options.length === 0 && overlay.emptyMessage ? (
        <RichText text={overlay.emptyMessage} tone="info" />
      ) : null}
      {overlay.options.map((option, index) => (
        <Box
          key={`overlay-${option.value ?? "cancel"}-${option.label}-${index}`}
          flexDirection="column"
          marginTop={index === 0 ? 1 : 0}
        >
          <Text
            color={getOverlayToneColor(option.tone)}
            inverse={index === overlay.selectedIndex}
          >
            {`${index === overlay.selectedIndex ? ">" : " "} ${option.label}`}
          </Text>
          <Box marginLeft={2}>
            <RichText text={option.description} tone="info" />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function DiffApprovalOverlay(props: {
  overlay: Extract<RendererOverlay, { kind: "diff" }>;
}): React.JSX.Element {
  const visibleLines = props.overlay.lines.slice(
    props.overlay.scrollOffset,
    props.overlay.scrollOffset + props.overlay.viewportHeight,
  );
  const scrollEnd = Math.min(
    props.overlay.lines.length,
    props.overlay.scrollOffset + props.overlay.viewportHeight,
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellowBright"
      marginTop={1}
      paddingX={1}
      paddingY={0}
    >
      <RichText text={props.overlay.title} />
      {props.overlay.subtitle ? <RichText text={props.overlay.subtitle} tone="info" /> : null}
      <RichText text={props.overlay.summary} />
      <Text color="yellowBright">
        {`Changed ${props.overlay.changeSummary.changedLines}  Added ${props.overlay.changeSummary.addedLines}  Removed ${props.overlay.changeSummary.removedLines}`}
      </Text>
      {props.overlay.truncated ? (
        <RichText text="Preview truncated to the first diff lines." tone="warning" />
      ) : null}
      <RichText
        text={`Showing lines ${props.overlay.scrollOffset + 1}-${scrollEnd} of ${props.overlay.lines.length}`}
        tone="info"
      />
      <Box flexDirection="column" marginTop={1}>
        {visibleLines.map((line, index) => (
          <DiffLine
            key={`diff-${props.overlay.scrollOffset + index}-${line.kind}-${line.oldLineNumber ?? "n"}-${line.newLineNumber ?? "n"}`}
            line={line}
          />
        ))}
      </Box>
      <Text dimColor>
        {props.overlay.mode === "approval"
          ? "Enter approve once  a allow-all  Esc reject"
          : "Enter close  Esc close"}
      </Text>
    </Box>
  );
}

function StatusBar(props: { text: string }): React.JSX.Element {
  return <Text dimColor>{props.text}</Text>;
}

function StyledLine(props: { line: RendererLine }): React.JSX.Element {
  const text = props.line.text;
  switch (props.line.kind) {
    case "section":
      return <Text bold>{text}</Text>;
    case "error":
      return (
        <Box flexDirection="row">
          <Text bold color="redBright">
            error:
          </Text>
          {text ? (
            <Box marginLeft={1}>
              <RichText text={text} tone="error" />
            </Box>
          ) : null}
        </Box>
      );
    case "warning":
      return <RichText text={text} tone="warning" />;
    case "assistant":
      return (
        <Box flexDirection="row">
          <Box marginRight={1}>
            <Text bold color="green">
              superrun &gt;
            </Text>
          </Box>
          <AssistantRichText text={text} />
        </Box>
      );
    case "body":
      return <RichText text={text} />;
    case "info":
    default:
      return <RichText text={text} tone="info" />;
  }
}

function DiffLine(props: {
  line: Extract<RendererOverlay, { kind: "diff" }>["lines"][number];
}): React.JSX.Element {
  const marker = props.line.kind === "add"
    ? "+"
    : props.line.kind === "remove"
      ? "-"
      : " ";
  const oldNumber = formatDiffLineNumber(props.line.oldLineNumber);
  const newNumber = formatDiffLineNumber(props.line.newLineNumber);
  const color = props.line.kind === "add"
    ? "green"
    : props.line.kind === "remove"
      ? "redBright"
      : "white";

  return (
    <Text color={color} dimColor={props.line.kind === "context"}>
      {`${marker} ${oldNumber} ${newNumber} ${props.line.text}`}
    </Text>
  );
}

function renderSuggestionLines(state: ComposerState): Array<{
  text: string;
  selected: boolean;
}> {
  if (state.activeReference === null) {
    return [];
  }

  if (state.suggestions.length === 0) {
    return [{ text: `  No files match "@${state.activeReference.query}".`, selected: false }];
  }

  return [
    {
      text: "  @ files - Up/Down to choose, Tab to insert",
      selected: false,
    },
    ...state.suggestions.map((match, index) => ({
      text: `${index === state.selectedSuggestionIndex ? ">" : " "} ${match}`,
      selected: index === state.selectedSuggestionIndex,
    })),
  ];
}

function getOverlayToneColor(
  tone: RendererPickerOverlay["options"][number]["tone"],
): "white" | "cyan" | "redBright" {
  switch (tone) {
    case "accent":
      return "cyan";
    case "danger":
      return "redBright";
    case "default":
    default:
      return "white";
  }
}

function formatDiffLineNumber(lineNumber: number | null): string {
  if (lineNumber === null) {
    return "   .";
  }

  return `${lineNumber}`.padStart(4, " ");
}
