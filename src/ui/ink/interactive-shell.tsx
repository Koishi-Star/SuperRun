import React from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { ComposerState } from "../composer-state.js";
import type { RendererLine, RendererPrompt } from "../interactive-renderer.js";

export type InteractiveShellProps = {
  headerLines: RendererLine[];
  logLines: RendererLine[];
  prompt: RendererPrompt;
  divider: string;
  inputActive: boolean;
  onInput: (input: string, key: Key) => void;
};

export function InteractiveShell(props: InteractiveShellProps): React.JSX.Element {
  useInput(
    (input, key) => {
      props.onInput(input, key);
    },
    { isActive: props.inputActive },
  );

  return (
    <Box flexDirection="column">
      <LineBlock lines={props.headerLines} />
      <LineBlock lines={props.logLines} />
      <Composer
        prompt={props.prompt}
        divider={props.divider}
        inputActive={props.inputActive}
      />
    </Box>
  );
}

function LineBlock(props: { lines: RendererLine[] }): React.JSX.Element {
  return (
    <>
      {props.lines.map((line) => (
        <StyledLine key={line.id} line={line} />
      ))}
    </>
  );
}

function Composer(props: {
  prompt: RendererPrompt;
  divider: string;
  inputActive: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>{props.divider}</Text>
      <PromptLine
        label={props.prompt.label}
        state={props.prompt.state}
        isActive={props.inputActive}
      />
      {props.prompt.state.errorMessage ? (
        <Text color="redBright">{`  ${props.prompt.state.errorMessage}`}</Text>
      ) : null}
      {renderSuggestionLines(props.prompt.state).map((line, index) => (
        <Text
          key={`suggestion-${index}`}
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
    <Text>
      <Text bold color={props.label.kind === "editor" ? "yellow" : "cyan"}>
        {props.label.text}
      </Text>
      {props.isActive
        ? (
            <>
              {beforeCursor}
              <Text inverse>{cursorCharacter || " "}</Text>
              {afterCursor}
            </>
          )
        : props.state.buffer}
    </Text>
  );
}

function StyledLine(props: { line: RendererLine }): React.JSX.Element {
  const text = props.line.text;
  switch (props.line.kind) {
    case "section":
      return <Text bold>{text}</Text>;
    case "error":
      return (
        <Text>
          <Text bold color="redBright">
            error:
          </Text>
          {text ? ` ${text}` : ""}
        </Text>
      );
    case "warning":
      return <Text color="yellowBright">{text}</Text>;
    case "assistant":
      return (
        <Text>
          <Text bold color="green">
            superrun &gt;{" "}
          </Text>
          {text}
        </Text>
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
