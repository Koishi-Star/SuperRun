import React from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { ComposerState } from "../composer-state.js";
import type {
  RendererLine,
  RendererOverlay,
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
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      marginTop={1}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color="cyan">
        {props.overlay.title}
      </Text>
      {props.overlay.subtitle ? <Text dimColor>{props.overlay.subtitle}</Text> : null}
      {props.overlay.options.length === 0 && props.overlay.emptyMessage ? (
        <Text dimColor>{props.overlay.emptyMessage}</Text>
      ) : null}
      {props.overlay.options.map((option, index) => (
        <Box
          key={`overlay-${option.value ?? "cancel"}-${option.label}-${index}`}
          flexDirection="column"
          marginTop={index === 0 ? 1 : 0}
        >
          <Text
            color={getOverlayToneColor(option.tone)}
            inverse={index === props.overlay.selectedIndex}
          >
            {`${index === props.overlay.selectedIndex ? ">" : " "} ${option.label}`}
          </Text>
          <Text dimColor>{`  ${option.description}`}</Text>
        </Box>
      ))}
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
          {text ? <Text>{` ${text}`}</Text> : null}
        </Box>
      );
    case "warning":
      return <Text color="yellowBright">{text}</Text>;
    case "assistant":
      return (
        <Box flexDirection="row">
          <Text bold color="green">
            superrun &gt;{" "}
          </Text>
          <Text>{text}</Text>
        </Box>
      );
    case "body":
      return <Text>{text}</Text>;
    case "info":
    default:
      return <Text dimColor>{text}</Text>;
  }
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
  tone: RendererOverlay["options"][number]["tone"],
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
