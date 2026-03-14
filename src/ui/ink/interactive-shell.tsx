import React, { useEffect, useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import { AssistantRichText, RichText } from "../assistant-rich-text.js";
import type { ComposerState } from "../composer-state.js";
import type {
  RendererAgentTurn,
  RendererDiffBlock,
  RendererLine,
  RendererOverlayOption,
  RendererPickerOverlay,
  RendererPrompt,
  RendererToolStep,
  RendererTurnCard,
} from "../interactive-renderer.js";

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

export type InteractiveShellProps = {
  headerLines: RendererLine[];
  turns: RendererTurnCard[];
  prompt: RendererPrompt;
  divider: string;
  inputEnabled?: boolean;
  inputMode: "inactive" | "prompt" | "overlay" | "inline";
  overlay: RendererPickerOverlay | null;
  statusText: string;
  commandViewportHeight: number;
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
      <HeaderCard lines={props.headerLines} />
      <TurnList turns={props.turns} commandViewportHeight={props.commandViewportHeight} />
      {props.overlay ? <OverlayPicker overlay={props.overlay} /> : null}
      {props.inputMode === "prompt"
        ? (
            <Composer
              prompt={props.prompt}
              divider={props.divider}
              inputMode={props.inputMode}
            />
          )
        : null}
      <StatusBar text={props.statusText} />
    </Box>
  );
}

function TurnList(props: {
  turns: RendererTurnCard[];
  commandViewportHeight: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.turns.map((turn, index) => (
        turn.kind === "system"
          ? <SystemTurn key={turn.id} turn={turn} isLatest={index === props.turns.length - 1} />
          : (
              <AgentTurn
                key={turn.id}
                turn={turn}
                isLatest={index === props.turns.length - 1}
                commandViewportHeight={props.commandViewportHeight}
              />
            )
      ))}
    </Box>
  );
}

function HeaderCard(props: { lines: RendererLine[] }): React.JSX.Element {
  if (props.lines.length === 0) {
    return <></>;
  }

  const layout = buildHeaderLayout(props.lines);
  const showSplitLayout = layout.right.length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      marginBottom={1}
      paddingX={1}
    >
      <Text bold color="yellow">{layout.title}</Text>
      {showSplitLayout ? (
        <Box flexDirection="row" marginTop={1}>
          <Box flexDirection="column" width="58%">
            <Text bold color="cyan">Workspace</Text>
            <LineBlock lines={layout.left} />
          </Box>
          <Box marginX={1}>
            <Text color="yellow">│</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold color="yellow">Status</Text>
            <LineBlock lines={layout.right} />
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <LineBlock lines={layout.left} />
        </Box>
      )}
      {layout.footer.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">─</Text>
          <LineBlock lines={layout.footer} />
        </Box>
      ) : null}
    </Box>
  );
}

function SystemTurn(props: {
  turn: Extract<RendererTurnCard, { kind: "system" }>;
  isLatest: boolean;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle={props.isLatest ? "round" : undefined}
      borderColor={props.isLatest ? "white" : undefined}
      marginTop={1}
      paddingX={1}
      marginLeft={props.isLatest ? 0 : 2}
    >
      <LineBlock lines={props.turn.lines} />
    </Box>
  );
}

function AgentTurn(props: {
  turn: RendererAgentTurn;
  isLatest: boolean;
  commandViewportHeight: number;
}): React.JSX.Element {
  const activeCommandStep = [...props.turn.steps].reverse().find((step) =>
    step.kind === "command" && step.status === "running"
  ) ?? null;
  const isFocused = props.isLatest || props.turn.status !== "completed";
  const showStepDetails = isFocused;
  const showAnswer = isFocused || props.turn.answerText.length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle={isFocused ? "round" : undefined}
      borderColor={isFocused ? getTurnBorderColor(props.turn.status) : undefined}
      marginTop={1}
      paddingX={1}
      marginLeft={isFocused ? 0 : 2}
    >
      <Box flexDirection="row" marginBottom={1}>
        <Text bold color={isFocused ? "cyan" : "white"} dimColor={!isFocused}>{"> "}</Text>
        <Text dimColor={!isFocused}>{props.turn.promptText}</Text>
      </Box>

      {props.turn.steps.length > 0 && showStepDetails ? (
        <Box flexDirection="column">
          {props.turn.steps.map((step) => (
            <ToolStepSummary
              key={step.id}
              step={step}
              isActive={activeCommandStep?.id === step.id}
              dimmed={!isFocused}
            />
          ))}
        </Box>
      ) : null}

      {props.turn.steps.length > 0 && !showStepDetails ? (
        <HistorySummary steps={props.turn.steps} />
      ) : null}

      {activeCommandStep ? (
        <CommandPanel
          step={activeCommandStep}
          viewportHeight={props.commandViewportHeight}
        />
      ) : null}

      {props.turn.inlineBlock
        ? props.turn.inlineBlock.kind === "approval"
          ? <ApprovalBlock turn={props.turn} />
          : <DiffBlock block={props.turn.inlineBlock} />
        : null}

      {props.turn.answerText && showAnswer ? (
        <Box marginTop={props.turn.steps.length > 0 || props.turn.inlineBlock ? 1 : 0}>
          <Box marginLeft={isFocused ? 0 : 2}>
            <AssistantRichText text={props.turn.answerText} />
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function ToolStepSummary(props: {
  step: RendererToolStep;
  isActive: boolean;
  dimmed: boolean;
}): React.JSX.Element {
  const statusColor = getStepColor(props.step);
  const marker = props.isActive
    ? `${useSpinnerFrame()} `
    : props.step.kind === "notice"
      ? "! "
      : "- ";

  return (
    <Box flexDirection="row">
      <Text color={statusColor} dimColor={props.dimmed}>{marker}</Text>
      <Text color={statusColor} dimColor={props.dimmed}>
        {`${props.step.title}  ${props.step.summary}`}
      </Text>
    </Box>
  );
}

function HistorySummary(props: { steps: RendererToolStep[] }): React.JSX.Element {
  const lastStep = props.steps[props.steps.length - 1] ?? null;
  const completedCount = props.steps.filter((step) => step.status === "completed").length;
  const failedCount = props.steps.filter((step) => step.status === "failed" || step.status === "timed_out").length;

  return (
    <Text dimColor>
      {`${props.steps.length} step${props.steps.length === 1 ? "" : "s"}  completed ${completedCount}  failed ${failedCount}${lastStep ? `  last ${lastStep.title}` : ""}`}
    </Text>
  );
}

function CommandPanel(props: {
  step: RendererToolStep;
  viewportHeight: number;
}): React.JSX.Element {
  const spinnerFrame = useSpinnerFrame();
  const visibleLines = props.step.outputLines.slice(-props.viewportHeight);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      marginTop={1}
      paddingX={1}
    >
      <Box flexDirection="row">
        <Text color="cyan">{`${spinnerFrame} `}</Text>
        <Text color="cyan">{props.step.command ?? "command"}</Text>
      </Box>
      <Text dimColor>{`cwd: ${props.step.cwd ?? "."}  category: ${props.step.category ?? "unknown"}  status: ${formatStepStatus(props.step)}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleLines.length === 0 ? <Text dimColor>(waiting for output)</Text> : null}
        {visibleLines.map((line, index) => (
          <Text
            key={`output-${props.step.id}-${index}-${line}`}
            color={line.startsWith("stderr |") ? "redBright" : "white"}
            dimColor={line.startsWith("stdout |")}
          >
            {line}
          </Text>
        ))}
      </Box>
      {props.step.outputTruncated ? (
        <Text color="yellowBright">Output truncated to the latest 200 lines.</Text>
      ) : null}
    </Box>
  );
}

function ApprovalBlock(props: {
  turn: RendererAgentTurn;
}): React.JSX.Element {
  const block = props.turn.inlineBlock;
  if (!block || block.kind !== "approval") {
    return <></>;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellowBright"
      marginTop={1}
      paddingX={1}
    >
      <RichText text={block.title} />
      {block.subtitle ? <RichText text={block.subtitle} tone="info" /> : null}
      {block.options.map((option, index) => (
        <Box key={`${option.value}-${index}`} flexDirection="column" marginTop={index === 0 ? 1 : 0}>
          <Text
            color={getOverlayToneColor(option.tone)}
            inverse={index === block.selectedIndex}
          >
            {`${index === block.selectedIndex ? ">" : " "} ${option.label}`}
          </Text>
          <Box marginLeft={2}>
            <RichText text={option.description} tone="info" />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function DiffBlock(props: { block: RendererDiffBlock }): React.JSX.Element {
  const visibleLines = props.block.lines.slice(
    props.block.scrollOffset,
    props.block.scrollOffset + props.block.viewportHeight,
  );
  const scrollEnd = Math.min(
    props.block.lines.length,
    props.block.scrollOffset + props.block.viewportHeight,
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellowBright"
      marginTop={1}
      paddingX={1}
    >
      <RichText text={props.block.title} />
      {props.block.subtitle ? <RichText text={props.block.subtitle} tone="info" /> : null}
      <RichText text={props.block.summary} />
      <Text color="yellowBright">
        {`Changed ${props.block.changeSummary.changedLines}  Added ${props.block.changeSummary.addedLines}  Removed ${props.block.changeSummary.removedLines}`}
      </Text>
      {props.block.truncated ? (
        <RichText text="Preview truncated to the first diff lines." tone="warning" />
      ) : null}
      <RichText
        text={`Showing lines ${props.block.scrollOffset + 1}-${scrollEnd} of ${props.block.lines.length}`}
        tone="info"
      />
      <Box flexDirection="column" marginTop={1}>
        {visibleLines.map((line, index) => (
          <DiffLine
            key={`diff-${props.block.scrollOffset + index}-${line.kind}-${line.oldLineNumber ?? "n"}-${line.newLineNumber ?? "n"}`}
            line={line}
          />
        ))}
      </Box>
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
        : <Text dimColor>{props.state.buffer}</Text>}
      {props.isActive ? <Text inverse>{cursorCharacter || " "}</Text> : null}
      {props.isActive ? <Text>{afterCursor}</Text> : null}
    </Box>
  );
}

function OverlayPicker(props: { overlay: RendererPickerOverlay }): React.JSX.Element {
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

function StatusBar(props: { text: string }): React.JSX.Element {
  return <Text dimColor>{props.text}</Text>;
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

function buildHeaderLayout(lines: RendererLine[]): {
  title: string;
  left: RendererLine[];
  right: RendererLine[];
  footer: RendererLine[];
} {
  const titleLine = lines.find((line) => line.kind === "section") ?? null;
  const contentLines = lines.filter((line) => line.id !== titleLine?.id);
  const footer = contentLines.filter((line) => line.text.startsWith("commands "));
  const bodyLines = contentLines.filter((line) => !line.text.startsWith("commands "));
  const right = bodyLines.filter((line) =>
    line.kind === "warning" ||
    line.text.startsWith("mode ") ||
    line.text.startsWith("history ")
  );
  const left = bodyLines.filter((line) => !right.some((candidate) => candidate.id === line.id));

  return {
    title: titleLine?.text ?? "SuperRun",
    left,
    right,
    footer,
  };
}

function StyledLine(props: { line: RendererLine }): React.JSX.Element {
  const text = props.line.text;
  switch (props.line.kind) {
    case "section":
      return <Text bold>{text}</Text>;
    case "error":
      return (
        <Box flexDirection="row">
          <Text bold color="redBright">error:</Text>
          <Box marginLeft={1}>
            <RichText text={text} tone="error" />
          </Box>
        </Box>
      );
    case "warning":
      return <RichText text={text} tone="warning" />;
    case "body":
      return <RichText text={text} />;
    case "info":
    default:
      return <RichText text={text} tone="info" />;
  }
}

function DiffLine(props: {
  line: RendererDiffBlock["lines"][number];
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

function useSpinnerFrame(): string {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      clearInterval(timer);
    };
  }, []);

  return SPINNER_FRAMES[frameIndex] ?? "|";
}

function getTurnBorderColor(
  status: RendererAgentTurn["status"],
): "white" | "cyan" | "yellowBright" | "green" | "redBright" {
  switch (status) {
    case "awaiting_approval":
      return "yellowBright";
    case "streaming_answer":
      return "green";
    case "failed":
      return "redBright";
    case "running_tools":
      return "cyan";
    case "completed":
    case "collecting_input":
    default:
      return "white";
  }
}

function getStepColor(
  step: RendererToolStep,
): "white" | "cyan" | "green" | "yellowBright" | "redBright" {
  if (step.status === "running") {
    return "cyan";
  }

  if (step.status === "completed") {
    return step.kind === "notice" ? "white" : "green";
  }

  if (step.status === "timed_out") {
    return "yellowBright";
  }

  return "redBright";
}

function formatStepStatus(step: RendererToolStep): string {
  if (step.timedOut) {
    return "timed out";
  }

  if (step.status === "running") {
    return "running";
  }

  if (step.exitCode !== null) {
    return `exit ${step.exitCode}`;
  }

  return step.status;
}

function getOverlayToneColor(
  tone: RendererOverlayOption["tone"],
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
