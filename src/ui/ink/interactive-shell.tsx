import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Box,
  measureElement,
  renderToString,
  Text,
  useInput,
  type DOMElement,
  type Key,
} from "ink";
import {
  AssistantRichText,
  type AssistantInlineSegment,
  type RichTextTone,
  parseAssistantRichText,
  renderMarkdownTableLines,
  RichText,
} from "../assistant-rich-text.js";
import type { ComposerState } from "../composer-state.js";
import type { ContextIndicatorTone } from "../context-indicator.js";
import { getDisplayWidth, truncateForTerminal } from "../terminal_format.js";
import { sliceTranscriptItems } from "../transcript-viewport.js";
import type {
  RendererAgentTurn,
  RendererContextMeter,
  RendererDiffBlock,
  RendererLine,
  RendererOverlay,
  RendererOverlayOption,
  RendererPickerOverlay,
  RendererPrompt,
  RendererShellFrame,
  RendererTranscriptViewport,
  RendererToolStep,
  RendererTurnCard,
  RendererViewerOverlay,
} from "../interactive-renderer.js";

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const WARNING_COLOR = "#ff8c42";
const WORKING_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

// ---------------------------------------------------------------------------
// Centralized spinner tick — a single setInterval drives all spinner
// animations in the tree, avoiding N independent timers that each trigger
// separate React re-renders.
// ---------------------------------------------------------------------------
const GLOBAL_SPINNER_INTERVAL_MS = 80;
const SpinnerTickContext = createContext<number>(0);

function SpinnerTickProvider(props: {
  active: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!props.active) {
      return;
    }

    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, GLOBAL_SPINNER_INTERVAL_MS);
    return () => { clearInterval(timer); };
  }, [props.active]);

  return (
    <SpinnerTickContext.Provider value={tick}>
      {props.children}
    </SpinnerTickContext.Provider>
  );
}

/** Derive a spinner frame from the shared tick. */
function useSpinnerFrame(options?: {
  enabled?: boolean;
  frames?: string[];
}): string {
  const tick = useContext(SpinnerTickContext);
  const enabled = options?.enabled ?? false;
  const frames = options?.frames ?? SPINNER_FRAMES;
  if (!enabled || frames.length <= 1) {
    return frames[0] ?? "|";
  }
  return frames[tick % frames.length] ?? frames[0] ?? "|";
}

export type InteractiveShellProps = {
  shellFrame: RendererShellFrame;
  turns: RendererTurnCard[];
  prompt: RendererPrompt;
  divider: string;
  shellHeight: number;
  inputEnabled?: boolean;
  inputMode: "inactive" | "prompt" | "overlay" | "inline";
  overlay: RendererOverlay | null;
  statusText: string;
  commandViewportHeight: number;
  transcriptViewport: RendererTranscriptViewport;
  transcriptViewportFallbackHeight: number;
  onInput: (input: string, key: Key) => void;
  onTranscriptViewportChange: (metrics: Pick<
    RendererTranscriptViewport,
    | "totalLines"
    | "viewportHeight"
    | "maxScrollOffsetLines"
    | "hiddenAboveLines"
    | "hiddenBelowLines"
    | "scrollOffsetLines"
  >) => void;
};

export type InteractiveShellDocument = {
  output: string;
  transcriptViewport: Pick<
    RendererTranscriptViewport,
    | "totalLines"
    | "viewportHeight"
    | "maxScrollOffsetLines"
    | "hiddenAboveLines"
    | "hiddenBelowLines"
    | "scrollOffsetLines"
  >;
};

export function InteractiveShell(props: InteractiveShellProps): React.JSX.Element {
  const contentWidth = props.divider.length;
  const hasActiveSpinner = props.turns.some((turn) =>
    turn.kind === "agent" && (
      turn.status === "running_tools" ||
      turn.status === "streaming_answer" ||
      turn.steps.some((step) => step.kind === "command" && step.status === "running")
    )
  );

  useInput(
    (input, key) => {
      props.onInput(input, key);
    },
    { isActive: props.inputEnabled ?? true },
  );

  return (
    <SpinnerTickProvider active={hasActiveSpinner}>
    <Box flexDirection="column" height={props.shellHeight} overflow="hidden">
      <StructuredHeaderCard frame={props.shellFrame} />
      <ContextMeterBar meter={props.shellFrame.contextMeter} width={contentWidth} />
      {props.shellFrame.noticeLines.length > 0 ? (
        <ShellNoticeBlock lines={props.shellFrame.noticeLines} />
      ) : null}
      <TranscriptViewport
        turns={props.turns}
        commandViewportHeight={props.commandViewportHeight}
        contentWidth={contentWidth}
        viewport={props.transcriptViewport}
        fallbackHeight={props.transcriptViewportFallbackHeight}
        onViewportChange={props.onTranscriptViewportChange}
      />
      {props.overlay
        ? props.overlay.kind === "picker"
          ? <OverlayPicker overlay={props.overlay} />
          : <OverlayViewer overlay={props.overlay} />
        : null}
      <Composer
        prompt={props.prompt}
        divider={props.divider}
        inputMode={props.inputMode}
        contextMeter={props.shellFrame.contextMeter}
      />
      <StatusBar text={props.statusText} width={props.divider.length} />
    </Box>
    </SpinnerTickProvider>
  );
}

export function renderInteractiveShellDocument(
  props: InteractiveShellProps & {
    spinnerTick?: number;
  },
): InteractiveShellDocument {
  const contentWidth = props.divider.length;
  const spinnerTick = props.spinnerTick ?? 0;
  const hasRunningCommand = props.turns.some((turn) =>
    turn.kind === "agent" &&
    turn.steps.some((step) => step.kind === "command" && step.status === "running")
  );
  const hasLockedPrompt = props.turns.some((turn) =>
    turn.kind === "agent" &&
    (turn.status === "running_tools" || turn.status === "streaming_answer")
  );
  const commandSpinnerFrame = pickSpinnerFrame(spinnerTick, {
    enabled: hasRunningCommand,
  });
  const workingSpinnerFrame = pickSpinnerFrame(spinnerTick, {
    enabled: hasLockedPrompt,
    frames: WORKING_SPINNER_FRAMES,
  });
  const headerLines = renderSectionToLines(
    (
      <StructuredHeaderCard frame={props.shellFrame} />
    ),
    contentWidth,
  );
  const contextMeterLines = renderSectionToLines(
    (
      <ContextMeterBar meter={props.shellFrame.contextMeter} width={contentWidth} />
    ),
    contentWidth,
  );
  const noticeLines = props.shellFrame.noticeLines.length > 0
    ? renderSectionToLines(
        (
          <ShellNoticeBlock lines={props.shellFrame.noticeLines} />
        ),
        contentWidth,
      )
    : [];
  const composerLines = renderSectionToLines(
    (
      <Composer
        prompt={props.prompt}
        divider={props.divider}
        inputMode={props.inputMode}
        contextMeter={props.shellFrame.contextMeter}
      />
    ),
    contentWidth,
  );
  const statusLines = renderSectionToLines(
    <StatusBar text={props.statusText} width={contentWidth} />,
    contentWidth,
  );
  const reservedLines =
    headerLines.length +
    contextMeterLines.length +
    noticeLines.length +
    composerLines.length +
    statusLines.length;
  const mainViewportHeight = Math.max(1, props.shellHeight - reservedLines);

  // Keep the shell layout pure and offscreen-renderable. The live renderer now
  // owns terminal diffing itself because Ink clears fullscreen output whenever
  // the render height reaches the terminal height, which caused the full-screen
  // flash on every prompt edit, spinner tick, and transcript scroll.
  const transcriptLines = buildTranscriptRenderableLines(props.turns, {
    commandViewportHeight: props.commandViewportHeight,
    contentWidth,
    commandSpinnerFrame,
    workingSpinnerFrame,
  });
  const visibleTranscript = sliceTranscriptItems(
    transcriptLines,
    mainViewportHeight,
    props.transcriptViewport.scrollOffsetLines,
    props.transcriptViewport.followLatest,
  );
  const renderableViewportLines = buildRenderableViewportLines(
    visibleTranscript,
    mainViewportHeight,
  );
  const renderedTranscriptLines = padSectionLines(
    renderSectionToLines(
    <TranscriptViewportBody lines={renderableViewportLines} />,
    contentWidth,
    ),
    mainViewportHeight,
  );
  const renderedOverlayLines = props.overlay
    ? fitOverlayBodyLines(props.overlay, mainViewportHeight, contentWidth)
    : [];
  // Overlays replace the central body viewport instead of stacking after the
  // transcript. Otherwise the viewer's own viewport math drifts from the real
  // visible area and part of /history becomes permanently unreachable.
  const bodyLines = props.overlay ? renderedOverlayLines : renderedTranscriptLines;
  const shellLines = [
    ...headerLines,
    ...contextMeterLines,
    ...noticeLines,
    ...bodyLines,
    ...composerLines,
    ...statusLines,
  ];

  while (shellLines.length < props.shellHeight) {
    shellLines.push(" ");
  }

  return {
    output: shellLines.slice(0, props.shellHeight).join("\n"),
    transcriptViewport: {
      totalLines: visibleTranscript.totalLines,
      viewportHeight: visibleTranscript.viewportHeight,
      maxScrollOffsetLines: visibleTranscript.maxScrollOffsetLines,
      hiddenAboveLines: visibleTranscript.hiddenAboveLines,
      hiddenBelowLines: visibleTranscript.hiddenBelowLines,
      scrollOffsetLines: visibleTranscript.scrollOffsetLines,
    },
  };
}

function StructuredHeaderCard(props: { frame: RendererShellFrame }): React.JSX.Element {
  if (
    props.frame.workspaceLines.length === 0 &&
    props.frame.statusLines.length === 0 &&
    props.frame.footerLines.length === 0
  ) {
    return <></>;
  }

  const showSplitLayout = props.frame.statusLines.length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      marginBottom={1}
      paddingX={1}
    >
      <Text bold color="yellow">{props.frame.title}</Text>
      {showSplitLayout ? (
        <Box flexDirection="row" marginTop={1}>
          <Box flexDirection="column" width="58%">
            <Text bold color="cyan">Workspace</Text>
            <LineBlock lines={props.frame.workspaceLines} />
          </Box>
          <Box marginX={1}>
            <Text color="yellow">|</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold color="yellow">Status</Text>
            <LineBlock lines={props.frame.statusLines} />
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <LineBlock lines={props.frame.workspaceLines} />
        </Box>
      )}
      {props.frame.footerLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">─</Text>
          <LineBlock lines={props.frame.footerLines} />
        </Box>
      ) : null}
    </Box>
  );
}

function ContextMeterBar(props: {
  meter: RendererContextMeter | null;
  width: number;
}): React.JSX.Element {
  const meter = props.meter;
  const width = Math.max(10, props.width);
  if (!meter) {
    return <Text dimColor color="gray">{fitSingleLine("ctx --/-- (--%)", width)}</Text>;
  }

  const toneProps = getContextToneTextProps(meter.display.tone);
  const summaryText = `ctx ${meter.display.usageText} (${meter.display.percentText})`;
  const suffix = ` ${meter.display.usageText} (${meter.display.percentText})`;
  const suffixWidth = getDisplayWidth(suffix);
  const prefixWidth = getDisplayWidth("ctx ");
  const minimumBarWidth = 8;
  const availableBarWidth = width - prefixWidth - suffixWidth;
  const barText = availableBarWidth >= minimumBarWidth
    ? buildContextBarCells(availableBarWidth, meter.display.ratio)
    : null;

  if (!barText) {
    return (
      <Box marginBottom={1}>
        <Text {...toneProps}>{fitSingleLine(summaryText, width)}</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Text {...toneProps}>ctx </Text>
      <Text {...toneProps}>{barText.filled}</Text>
      <Text dimColor color="gray">{barText.empty}</Text>
      <Text {...toneProps}>{suffix}</Text>
    </Box>
  );
}

function ShellNoticeBlock(props: { lines: RendererLine[] }): React.JSX.Element {
  const borderColor = props.lines.some((line) => line.kind === "warning" || line.color === "redBright")
    ? "yellow"
    : "cyan";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      marginBottom={1}
      paddingX={1}
    >
      <LineBlock lines={props.lines} />
    </Box>
  );
}

function TurnList(props: {
  turns: RendererTurnCard[];
  commandViewportHeight: number;
  contentWidth: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.turns.map((turn, index) => (
        turn.kind === "system"
          ? (
              <SystemTurn
                key={turn.id}
                turn={turn}
                isLatest={index === props.turns.length - 1}
                isFirst={index === 0}
              />
            )
          : (
              <AgentTurn
                key={turn.id}
                turn={turn}
                isFirst={index === 0}
                isLatest={index === props.turns.length - 1}
                commandViewportHeight={props.commandViewportHeight}
                contentWidth={props.contentWidth}
              />
            )
      ))}
    </Box>
  );
}

function TranscriptViewport(props: {
  turns: RendererTurnCard[];
  commandViewportHeight: number;
  contentWidth: number;
  viewport: RendererTranscriptViewport;
  fallbackHeight: number;
  onViewportChange: InteractiveShellProps["onTranscriptViewportChange"];
}): React.JSX.Element {
  const containerRef = useRef<DOMElement | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState(Math.max(1, props.fallbackHeight));
  const hasRunningCommand = props.turns.some((turn) =>
    turn.kind === "agent" &&
    turn.steps.some((step) => step.kind === "command" && step.status === "running")
  );
  const hasLockedPrompt = props.turns.some((turn) =>
    turn.kind === "agent" &&
    (turn.status === "running_tools" || turn.status === "streaming_answer")
  );
  const commandSpinnerFrame = useSpinnerFrame({ enabled: hasRunningCommand });
  const workingSpinnerFrame = useSpinnerFrame({
    enabled: hasLockedPrompt,
    frames: WORKING_SPINNER_FRAMES,
  });
  const latestMetricsRef = useRef(sliceTranscriptItems<TranscriptRenderableLine>(
    [],
    Math.max(1, props.fallbackHeight),
    0,
    true,
  ));
  const reportedMetricsRef = useRef("");
  const viewportHeight = Math.max(1, measuredHeight);
  const transcriptLines = buildTranscriptRenderableLines(props.turns, {
    commandViewportHeight: props.commandViewportHeight,
    contentWidth: props.contentWidth,
    commandSpinnerFrame,
    workingSpinnerFrame,
  });
  const visibleTranscript = sliceTranscriptItems(
    transcriptLines,
    viewportHeight,
    props.viewport.scrollOffsetLines,
    props.viewport.followLatest,
  );
  latestMetricsRef.current = visibleTranscript;
  const renderableViewportLines = buildRenderableViewportLines(
    visibleTranscript,
    viewportHeight,
  );

  useLayoutEffect(() => {
    if (!containerRef.current) {
      return;
    }

    // Measure the real flexed height of the transcript box and keep the live
    // transcript clipped to that exact window. This is the shell's hard stop
    // against full-screen reflow when streamed output grows.
    const nextHeight = Math.max(1, measureElement(containerRef.current).height);
    if (nextHeight !== measuredHeight) {
      setMeasuredHeight(nextHeight);
    }
  });

  useLayoutEffect(() => {
    const nextMetrics = latestMetricsRef.current;
    const nextSignature = [
      nextMetrics.totalLines,
      nextMetrics.viewportHeight,
      nextMetrics.maxScrollOffsetLines,
      nextMetrics.hiddenAboveLines,
      nextMetrics.hiddenBelowLines,
      nextMetrics.scrollOffsetLines,
    ].join(":");

    if (reportedMetricsRef.current === nextSignature) {
      return;
    }

    reportedMetricsRef.current = nextSignature;
    props.onViewportChange({
      totalLines: nextMetrics.totalLines,
      viewportHeight: nextMetrics.viewportHeight,
      maxScrollOffsetLines: nextMetrics.maxScrollOffsetLines,
      hiddenAboveLines: nextMetrics.hiddenAboveLines,
      hiddenBelowLines: nextMetrics.hiddenBelowLines,
      scrollOffsetLines: nextMetrics.scrollOffsetLines,
    });
  });

  return (
    <Box
      ref={containerRef}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={1}
      overflow="hidden"
    >
      <TranscriptViewportBody lines={renderableViewportLines} />
    </Box>
  );
}

function TranscriptViewportBody(props: {
  lines: TranscriptRenderableLine[];
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.lines.map((line, index) => (
        <TranscriptViewportLineRow
          key={`${line.id}-${index}`}
          line={line}
        />
      ))}
    </Box>
  );
}

type TranscriptRenderOptions = {
  commandViewportHeight: number;
  contentWidth: number;
  commandSpinnerFrame: string;
  workingSpinnerFrame: string;
};

type TranscriptRenderableChunk = {
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  inverse?: boolean;
};

type TranscriptRenderableLine = {
  id: string;
  indent?: number;
  chunks: TranscriptRenderableChunk[];
};

function buildRenderableViewportLines(
  slice: ReturnType<typeof sliceTranscriptItems<TranscriptRenderableLine>>,
  viewportHeight: number,
): TranscriptRenderableLine[] {
  const lines = [...slice.items];

  while (lines.length < viewportHeight) {
    lines.push(buildTranscriptBlankLine(`pad_${lines.length}`));
  }

  if (slice.hiddenAboveLines > 0 && lines.length > 0) {
    lines[0] = buildTranscriptHintLine(
      `hint_above_${slice.hiddenAboveLines}`,
      `^ ${slice.hiddenAboveLines} earlier line${slice.hiddenAboveLines === 1 ? "" : "s"}`,
    );
  }

  if (slice.hiddenBelowLines > 0 && lines.length > 0) {
    lines[lines.length - 1] = buildTranscriptHintLine(
      `hint_below_${slice.hiddenBelowLines}`,
      `v ${slice.hiddenBelowLines} newer line${slice.hiddenBelowLines === 1 ? "" : "s"}`,
    );
  }

  return lines;
}

function TranscriptViewportLineRow(props: {
  line: TranscriptRenderableLine;
}): React.JSX.Element {
  const content = (
    <Box flexDirection="row">
      {props.line.chunks.map((chunk, index) => (
        <Text
          key={`${props.line.id}-${index}`}
          {...(chunk.color ? { color: chunk.color } : {})}
          dimColor={chunk.dimColor ?? false}
          bold={chunk.bold ?? false}
          inverse={chunk.inverse ?? false}
          wrap="truncate-end"
        >
          {chunk.text.length > 0 ? chunk.text : " "}
        </Text>
      ))}
    </Box>
  );

  if (!props.line.indent || props.line.indent <= 0) {
    return content;
  }

  return <Box marginLeft={props.line.indent}>{content}</Box>;
}

function renderSectionToLines(
  node: React.ReactNode,
  columns: number,
): string[] {
  const output = renderToString(node, { columns: Math.max(1, columns) });
  if (!output) {
    return [];
  }

  return output.replace(/\r\n/g, "\n").split("\n");
}

function padSectionLines(
  lines: string[],
  height: number,
): string[] {
  const padded = lines.slice(0, height);

  while (padded.length < height) {
    padded.push(" ");
  }

  return padded;
}

function fitOverlayBodyLines(
  overlay: RendererOverlay,
  availableHeight: number,
  contentWidth: number,
): string[] {
  if (overlay.kind !== "viewer") {
    return padSectionLines(
      renderSectionToLines(<OverlayPicker overlay={overlay} />, contentWidth),
      availableHeight,
    );
  }

  let nextOverlay: RendererViewerOverlay = {
    ...overlay,
    viewportHeight: Math.max(1, Math.min(overlay.viewportHeight, availableHeight)),
  };
  let renderedLines = renderSectionToLines(
    <OverlayViewer overlay={nextOverlay} />,
    contentWidth,
  );

  while (renderedLines.length > availableHeight && nextOverlay.viewportHeight > 1) {
    nextOverlay = {
      ...nextOverlay,
      viewportHeight: nextOverlay.viewportHeight - 1,
    };
    renderedLines = renderSectionToLines(
      <OverlayViewer overlay={nextOverlay} />,
      contentWidth,
    );
  }

  return padSectionLines(renderedLines, availableHeight);
}

function pickSpinnerFrame(
  tick: number,
  options?: {
    enabled?: boolean;
    frames?: string[];
  },
): string {
  const enabled = options?.enabled ?? false;
  const frames = options?.frames ?? SPINNER_FRAMES;
  if (!enabled || frames.length <= 1) {
    return frames[0] ?? "|";
  }

  return frames[tick % frames.length] ?? frames[0] ?? "|";
}

function buildTranscriptRenderableLines(
  turns: RendererTurnCard[],
  options: TranscriptRenderOptions,
): TranscriptRenderableLine[] {
  const lines: TranscriptRenderableLine[] = [];
  let nextId = 0;
  const makeId = (label: string) => `${label}_${nextId += 1}`;

  turns.forEach((turn, index) => {
    if (index > 0) {
      lines.push(buildTranscriptBlankLine(makeId("gap")));
    }

    const turnLines = turn.kind === "system"
      ? buildSystemTurnRenderableLines(turn, options.contentWidth, index === turns.length - 1, makeId)
      : buildAgentTurnRenderableLines(turn, options, index === turns.length - 1, makeId);
    lines.push(...turnLines);
  });

  return lines;
}

function buildSystemTurnRenderableLines(
  turn: Extract<RendererTurnCard, { kind: "system" }>,
  contentWidth: number,
  isLatest: boolean,
  makeId: (label: string) => string,
): TranscriptRenderableLine[] {
  const indent = isLatest ? 0 : 2;
  return turn.lines.flatMap((line) =>
    renderRendererLineToRenderableLines(line, contentWidth, indent, makeId)
  );
}

function buildAgentTurnRenderableLines(
  turn: RendererAgentTurn,
  options: TranscriptRenderOptions,
  isLatest: boolean,
  makeId: (label: string) => string,
): TranscriptRenderableLine[] {
  const lines: TranscriptRenderableLine[] = [];
  const activeCommandStep = [...turn.steps].reverse().find((step) =>
    step.kind === "command" && step.status === "running"
  ) ?? null;
  const isFocused = isLatest || turn.status !== "completed";
  const showLockedPromptStyle =
    turn.status === "running_tools" || turn.status === "streaming_answer";
  const showStepDetails = isFocused;
  const showAnswer = isFocused || turn.answerText.length > 0;
  const indent = isFocused ? 0 : 2;

  lines.push(...buildWrappedTranscriptLines({
    idPrefix: makeId("prompt"),
    width: options.contentWidth,
    indent,
    prefix: [
      ...(showLockedPromptStyle ? [{ text: `${options.workingSpinnerFrame} `, color: "gray" }] : []),
      {
        text: "> ",
        color: showLockedPromptStyle ? "gray" : isFocused ? "cyan" : "white",
        bold: true,
        dimColor: !showLockedPromptStyle && !isFocused,
      },
    ],
    body: [
      {
        text: turn.promptText,
        ...(showLockedPromptStyle ? { color: "white" } : {}),
        dimColor: !showLockedPromptStyle && !isFocused,
      },
    ],
  }));

  if (turn.steps.length > 0 && showStepDetails) {
    for (const step of turn.steps) {
      const marker = activeCommandStep?.id === step.id
        ? {
            text: `${options.commandSpinnerFrame} `,
            color: getStepColor(step),
            dimColor: !isFocused,
          }
        : {
            text: step.kind === "notice" ? "! " : "- ",
            color: getStepColor(step),
            dimColor: !isFocused,
          };
      lines.push(...buildWrappedTranscriptLines({
        idPrefix: makeId("step"),
        width: options.contentWidth,
        indent,
        prefix: [marker],
        body: [{
          text: `${step.title}  ${step.summary}`,
          color: getStepColor(step),
          dimColor: !isFocused,
        }],
      }));
    }
  } else if (turn.steps.length > 0) {
    lines.push(...buildWrappedTranscriptLines({
      idPrefix: makeId("history"),
      width: options.contentWidth,
      indent,
      body: [{
        text: `${turn.steps.length} step${turn.steps.length === 1 ? "" : "s"}  completed ${turn.steps.filter((step) => step.status === "completed").length}  failed ${turn.steps.filter((step) => step.status === "failed" || step.status === "timed_out").length}`,
        dimColor: true,
      }],
    }));
  }

  if (activeCommandStep) {
    lines.push(buildTranscriptBlankLine(makeId("gap")));
    lines.push(...buildCommandPanelRenderableLines(
      activeCommandStep,
      options.commandViewportHeight,
      options.contentWidth,
      indent,
      options.commandSpinnerFrame,
      makeId,
    ));
  }

  if (turn.inlineBlock) {
    lines.push(buildTranscriptBlankLine(makeId("gap")));
    lines.push(...(
      turn.inlineBlock.kind === "approval"
        ? buildApprovalRenderableLines(turn.inlineBlock, options.contentWidth, indent, makeId)
        : buildDiffRenderableLines(turn.inlineBlock, options.contentWidth, indent, makeId)
    ));
  }

  if (turn.answerText && showAnswer) {
    lines.push(buildTranscriptBlankLine(makeId("gap")));
    lines.push(...renderRichTextToRenderableLines(
      turn.answerText,
      "assistant",
      options.contentWidth,
      indent,
      makeId,
    ));
  }

  return lines;
}

function buildCommandPanelRenderableLines(
  step: RendererToolStep,
  viewportHeight: number,
  contentWidth: number,
  indent: number,
  spinnerFrame: string,
  makeId: (label: string) => string,
): TranscriptRenderableLine[] {
  const visibleLines = step.outputLines.slice(-viewportHeight);
  const renderedLines = visibleLines.length === 0
    ? ["(waiting for output)"]
    : visibleLines;
  const lines = [
    ...buildWrappedTranscriptLines({
      idPrefix: makeId("command"),
      width: contentWidth,
      indent,
      prefix: [{ text: `${spinnerFrame} `, color: "cyan" }],
      body: [{ text: step.command ?? "command", color: "cyan" }],
    }),
    ...buildWrappedTranscriptLines({
      idPrefix: makeId("command-meta"),
      width: contentWidth,
      indent,
      body: [{
        text: `cwd: ${step.cwd ?? "."}  category: ${step.category ?? "unknown"}  status: ${formatStepStatus(step)}`,
        dimColor: true,
      }],
    }),
  ];

  renderedLines.forEach((line) => {
    lines.push(...buildWrappedTranscriptLines({
      idPrefix: makeId("command-output"),
      width: contentWidth,
      indent,
      body: [{
        text: line,
        ...(line.startsWith("stderr |") ? { color: "redBright" } : {}),
        dimColor: line === "(waiting for output)" || line.startsWith("stdout |"),
      }],
    }));
  });

  if (step.outputTruncated) {
    lines.push(...buildWrappedTranscriptLines({
      idPrefix: makeId("command-truncated"),
      width: contentWidth,
      indent,
      body: [{ text: "Output truncated to the latest 200 lines.", color: "yellowBright" }],
    }));
  }

  return lines;
}

function buildApprovalRenderableLines(
  block: Extract<RendererAgentTurn["inlineBlock"], { kind: "approval" }>,
  contentWidth: number,
  indent: number,
  makeId: (label: string) => string,
): TranscriptRenderableLine[] {
  const lines = [
    ...renderRichTextToRenderableLines(block.title, "default", contentWidth, indent, makeId),
  ];

  if (block.subtitle) {
    lines.push(...renderRichTextToRenderableLines(block.subtitle, "info", contentWidth, indent, makeId));
  }

  block.options.forEach((option, index) => {
    const selected = index === block.selectedIndex;
    lines.push(...buildWrappedTranscriptLines({
      idPrefix: makeId("approval"),
      width: contentWidth,
      indent,
      prefix: [{
        text: selected ? "> " : "  ",
        color: getOverlayToneColor(option.tone),
        inverse: selected,
      }],
      body: [{
        text: option.label,
        color: getOverlayToneColor(option.tone),
        inverse: selected,
      }],
    }));
    lines.push(...renderRichTextToRenderableLines(option.description, "info", contentWidth, indent + 2, makeId));
  });

  return lines;
}

function buildDiffRenderableLines(
  block: Extract<RendererAgentTurn["inlineBlock"], { kind: "diff" }>,
  contentWidth: number,
  indent: number,
  makeId: (label: string) => string,
): TranscriptRenderableLine[] {
  const visibleLines = block.lines.slice(
    block.scrollOffset,
    block.scrollOffset + block.viewportHeight,
  );
  const scrollEnd = Math.min(
    block.lines.length,
    block.scrollOffset + block.viewportHeight,
  );
  const lines = [
    ...renderRichTextToRenderableLines(block.title, "default", contentWidth, indent, makeId),
  ];

  if (block.subtitle) {
    lines.push(...renderRichTextToRenderableLines(block.subtitle, "info", contentWidth, indent, makeId));
  }

  lines.push(...renderRichTextToRenderableLines(block.summary, "default", contentWidth, indent, makeId));
  lines.push(...buildWrappedTranscriptLines({
    idPrefix: makeId("diff-summary"),
    width: contentWidth,
    indent,
    body: [{
      text: `Changed ${block.changeSummary.changedLines}  Added ${block.changeSummary.addedLines}  Removed ${block.changeSummary.removedLines}`,
      color: "yellowBright",
    }],
  }));

  if (block.truncated) {
    lines.push(...renderRichTextToRenderableLines("Preview truncated to the first diff lines.", "warning", contentWidth, indent, makeId));
  }

  lines.push(...renderRichTextToRenderableLines(
    `Showing lines ${block.scrollOffset + 1}-${scrollEnd} of ${block.lines.length}`,
    "info",
    contentWidth,
    indent,
    makeId,
  ));

  visibleLines.forEach((line) => {
    const marker = line.kind === "add"
      ? "+"
      : line.kind === "remove"
        ? "-"
        : " ";
    const color = line.kind === "add"
      ? "green"
      : line.kind === "remove"
        ? "redBright"
        : undefined;
    lines.push(...buildWrappedTranscriptLines({
      idPrefix: makeId("diff-line"),
      width: contentWidth,
      indent,
      body: [{
        text: `${marker} ${formatDiffLineNumber(line.oldLineNumber)} ${formatDiffLineNumber(line.newLineNumber)} ${line.text}`,
        ...(color ? { color } : {}),
        dimColor: line.kind === "context",
      }],
    }));
  });

  return lines;
}

function renderRendererLineToRenderableLines(
  line: RendererLine,
  contentWidth: number,
  indent: number,
  makeId: (label: string) => string,
): TranscriptRenderableLine[] {
  if (line.color || line.dimColor !== undefined) {
    return buildWrappedTranscriptLines({
      idPrefix: makeId("system"),
      width: contentWidth,
      indent,
      body: [{
        text: line.text,
        ...(line.color ? { color: line.color } : {}),
        ...(line.dimColor !== undefined ? { dimColor: line.dimColor } : {}),
      }],
    });
  }

  switch (line.kind) {
    case "section":
      return buildWrappedTranscriptLines({
        idPrefix: makeId("system-section"),
        width: contentWidth,
        indent,
        body: [{ text: line.text, bold: true }],
      });
    case "error":
      return [
        ...buildWrappedTranscriptLines({
          idPrefix: makeId("system-error"),
          width: contentWidth,
          indent,
          prefix: [{ text: "error: ", color: "redBright", bold: true }],
          body: [{ text: line.text, color: "redBright" }],
        }),
      ];
    case "warning":
      return renderRichTextToRenderableLines(line.text, "warning", contentWidth, indent, makeId);
    case "body":
      return renderRichTextToRenderableLines(line.text, "default", contentWidth, indent, makeId);
    case "info":
    default:
      return renderRichTextToRenderableLines(line.text, "info", contentWidth, indent, makeId);
  }
}

function renderRichTextToRenderableLines(
  text: string,
  tone: RichTextTone,
  contentWidth: number,
  indent: number,
  makeId: (label: string) => string,
): TranscriptRenderableLine[] {
  const lines: TranscriptRenderableLine[] = [];

  for (const block of parseAssistantRichText(text)) {
    switch (block.kind) {
      case "blank":
        lines.push(buildTranscriptBlankLine(makeId("rich-blank"), indent));
        break;
      case "heading":
        lines.push(...buildWrappedTranscriptLines({
          idPrefix: makeId("rich-heading"),
          width: contentWidth,
          indent,
          body: mapAssistantSegmentsToChunks(block.segments, {
            color: getTranscriptHeadingColor(block.level, tone),
            dimColor: tone === "info",
            bold: true,
          }),
        }));
        break;
      case "quote":
        lines.push(...buildWrappedTranscriptLines({
          idPrefix: makeId("rich-quote"),
          width: contentWidth,
          indent,
          prefix: [{ text: "> ", color: "magentaBright" }],
          body: mapAssistantSegmentsToChunks(block.segments, {
            color: getTranscriptBaseColor(tone),
            dimColor: tone === "info",
          }),
        }));
        break;
      case "list_item":
        lines.push(...buildWrappedTranscriptLines({
          idPrefix: makeId("rich-list"),
          width: contentWidth,
          indent,
          prefix: [{ text: `${block.marker} `, color: "cyan" }],
          body: mapAssistantSegmentsToChunks(block.segments, {
            color: getTranscriptBaseColor(tone),
            dimColor: tone === "info",
          }),
        }));
        break;
      case "code_block":
        lines.push(buildTranscriptLine(makeId("rich-code-fence"), [{ text: `\`\`\`${block.language ?? ""}`, color: "magentaBright" }], indent));
        for (const codeLine of block.code.split("\n")) {
          lines.push(buildTranscriptLine(makeId("rich-code-line"), [
            { text: "| ", color: "magentaBright" },
            { text: codeLine.length > 0 ? codeLine : " ", color: getTranscriptBaseColor(tone), dimColor: tone === "info" },
          ], indent));
        }
        lines.push(buildTranscriptLine(makeId("rich-code-close"), [{ text: "```", color: "magentaBright" }], indent));
        break;
      case "table": {
        const tableLines = renderMarkdownTableLines({
          headers: block.headers,
          rows: block.rows,
          alignments: block.alignments,
        }, Math.max(1, contentWidth - indent));
        tableLines.forEach((tableLine, tableIndex) => {
          const isBorder = tableIndex === 0 || tableIndex === 2 || tableIndex === tableLines.length - 1;
          const isHeader = tableIndex === 1;
          lines.push(buildTranscriptLine(makeId("rich-table"), [{
            text: tableLine,
            color: isBorder ? "cyan" : getTranscriptBaseColor(tone),
            dimColor: tone === "info" && !isBorder,
            bold: isHeader,
          }], indent));
        });
        break;
      }
      case "paragraph":
      default:
        lines.push(...buildWrappedTranscriptLines({
          idPrefix: makeId("rich-paragraph"),
          width: contentWidth,
          indent,
          body: mapAssistantSegmentsToChunks(block.segments, {
            color: getTranscriptBaseColor(tone),
            dimColor: tone === "info",
          }),
        }));
        break;
    }
  }

  return lines.length > 0 ? lines : [buildTranscriptBlankLine(makeId("rich-empty"), indent)];
}

function mapAssistantSegmentsToChunks(
  segments: AssistantInlineSegment[],
  defaults: Omit<TranscriptRenderableChunk, "text">,
): TranscriptRenderableChunk[] {
  return segments.map((segment) => {
    switch (segment.kind) {
      case "bold":
        return {
          text: segment.text,
          ...defaults,
          bold: true,
        };
      case "code":
        return {
          text: segment.text,
          color: "magentaBright",
          dimColor: false,
          bold: false,
        };
      case "text":
      default:
        return {
          text: segment.text,
          ...defaults,
        };
    }
  });
}

function buildWrappedTranscriptLines(options: {
  idPrefix: string;
  width: number;
  indent?: number;
  prefix?: TranscriptRenderableChunk[];
  body: TranscriptRenderableChunk[];
}): TranscriptRenderableLine[] {
  const indent = options.indent ?? 0;
  const prefix = options.prefix ?? [];
  const prefixWidth = getTranscriptChunkWidth(prefix);
  const bodyWidth = Math.max(1, options.width - indent - prefixWidth);
  const wrappedBodyLines = wrapTranscriptChunks(options.body, bodyWidth);
  const continuationPrefix = prefixWidth > 0 ? [{ text: " ".repeat(prefixWidth) }] : [];

  return wrappedBodyLines.map((chunks, index) => buildTranscriptLine(
    `${options.idPrefix}_${index}`,
    [...(index === 0 ? prefix : continuationPrefix), ...chunks],
    indent,
  ));
}

function wrapTranscriptChunks(
  chunks: TranscriptRenderableChunk[],
  width: number,
): TranscriptRenderableChunk[][] {
  const safeWidth = Math.max(1, width);
  const lines: TranscriptRenderableChunk[][] = [[]];
  let currentWidth = 0;

  for (const chunk of chunks) {
    for (const character of chunk.text) {
      const characterWidth = Math.max(1, getDisplayWidth(character));
      if (currentWidth > 0 && currentWidth + characterWidth > safeWidth) {
        lines.push([]);
        currentWidth = 0;
      }

      appendTranscriptChunk(lines[lines.length - 1] ?? (lines[0] = []), {
        ...chunk,
        text: character,
      });
      currentWidth += characterWidth;
    }
  }

  return lines.map((line) => line.length > 0 ? line : [{ text: " " }]);
}

function appendTranscriptChunk(
  line: TranscriptRenderableChunk[],
  chunk: TranscriptRenderableChunk,
): void {
  const previous = line[line.length - 1];
  if (previous && transcriptChunkStyleEquals(previous, chunk)) {
    previous.text += chunk.text;
    return;
  }

  line.push({ ...chunk });
}

function transcriptChunkStyleEquals(
  left: TranscriptRenderableChunk,
  right: TranscriptRenderableChunk,
): boolean {
  return (
    left.color === right.color &&
    left.dimColor === right.dimColor &&
    left.bold === right.bold &&
    left.inverse === right.inverse
  );
}

function getTranscriptChunkWidth(chunks: TranscriptRenderableChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + getDisplayWidth(chunk.text), 0);
}

function buildTranscriptLine(
  id: string,
  chunks: TranscriptRenderableChunk[],
  indent = 0,
): TranscriptRenderableLine {
  return {
    id,
    indent,
    chunks: chunks.length > 0 ? chunks : [{ text: " " }],
  };
}

function buildTranscriptBlankLine(
  id: string,
  indent = 0,
): TranscriptRenderableLine {
  return buildTranscriptLine(id, [{ text: " " }], indent);
}

function buildTranscriptHintLine(
  id: string,
  text: string,
): TranscriptRenderableLine {
  return buildTranscriptLine(id, [{ text, color: "yellow", dimColor: true }]);
}

function getTranscriptBaseColor(tone: RichTextTone): string {
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

function getTranscriptHeadingColor(
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

function buildTranscriptOutput(
  turns: RendererTurnCard[],
  options: TranscriptRenderOptions,
): string {
  const lines: string[] = [];

  turns.forEach((turn, index) => {
    if (index > 0) {
      lines.push("");
    }

    const turnLines = turn.kind === "system"
      ? buildSystemTurnTranscriptLines(turn, {
          isFirst: index === 0,
          isLatest: index === turns.length - 1,
          contentWidth: options.contentWidth,
        })
      : buildAgentTurnTranscriptLines(turn, {
          isFirst: index === 0,
          isLatest: index === turns.length - 1,
          ...options,
        });

    lines.push(...turnLines);
  });

  return lines.join("\n");
}

function buildSystemTurnTranscriptLines(
  turn: Extract<RendererTurnCard, { kind: "system" }>,
  options: {
    isFirst: boolean;
    isLatest: boolean;
    contentWidth: number;
  },
): string[] {
  const indent = options.isLatest ? "" : "  ";
  return turn.lines.flatMap((line) => renderRendererLineToTranscriptLines(line, options.contentWidth, indent));
}

function buildAgentTurnTranscriptLines(
  turn: RendererAgentTurn,
  options: TranscriptRenderOptions & {
    isFirst: boolean;
    isLatest: boolean;
  },
): string[] {
  const lines: string[] = [];
  const activeCommandStep = [...turn.steps].reverse().find((step) =>
    step.kind === "command" && step.status === "running"
  ) ?? null;
  const isFocused = options.isLatest || turn.status !== "completed";
  const showLockedPromptStyle =
    turn.status === "running_tools" || turn.status === "streaming_answer";
  const showStepDetails = isFocused;
  const showAnswer = isFocused || turn.answerText.length > 0;
  const indent = isFocused ? "" : "  ";
  const promptPrefix = `${showLockedPromptStyle ? `${options.workingSpinnerFrame} ` : ""}> `;

  lines.push(...wrapPrefixedTranscriptLine(promptPrefix, turn.promptText, options.contentWidth, indent));

  if (turn.steps.length > 0 && showStepDetails) {
    for (const step of turn.steps) {
      const marker = activeCommandStep?.id === step.id
        ? `${options.commandSpinnerFrame} `
        : step.kind === "notice"
          ? "! "
          : "- ";
      lines.push(...wrapPrefixedTranscriptLine(
        marker,
        `${step.title}  ${step.summary}`,
        options.contentWidth,
        indent,
      ));
    }
  } else if (turn.steps.length > 0) {
    lines.push(...wrapTranscriptText(
      `${turn.steps.length} step${turn.steps.length === 1 ? "" : "s"}  completed ${turn.steps.filter((step) => step.status === "completed").length}  failed ${turn.steps.filter((step) => step.status === "failed" || step.status === "timed_out").length}`,
      options.contentWidth,
      indent,
    ));
  }

  if (activeCommandStep) {
    lines.push("");
    lines.push(...buildCommandPanelTranscriptLines(
      activeCommandStep,
      options.commandViewportHeight,
      options.contentWidth,
      indent,
      options.commandSpinnerFrame,
    ));
  }

  if (turn.inlineBlock) {
    lines.push("");
    lines.push(...(
      turn.inlineBlock.kind === "approval"
        ? buildApprovalTranscriptLines(turn.inlineBlock, options.contentWidth, indent)
        : buildDiffTranscriptLines(turn.inlineBlock, options.contentWidth, indent)
    ));
  }

  if (turn.answerText && showAnswer) {
    lines.push("");
    lines.push(...renderRichTextToTranscriptLines(turn.answerText, options.contentWidth, indent));
  }

  return lines;
}

function buildCommandPanelTranscriptLines(
  step: RendererToolStep,
  viewportHeight: number,
  contentWidth: number,
  indent: string,
  spinnerFrame: string,
): string[] {
  const visibleLines = step.outputLines.slice(-viewportHeight);
  const renderedLines = visibleLines.length === 0
    ? ["(waiting for output)"]
    : visibleLines;
  const lines = [
    ...wrapPrefixedTranscriptLine(`${spinnerFrame} `, step.command ?? "command", contentWidth, indent),
    ...wrapTranscriptText(
      `cwd: ${step.cwd ?? "."}  category: ${step.category ?? "unknown"}  status: ${formatStepStatus(step)}`,
      contentWidth,
      indent,
    ),
  ];

  for (const outputLine of renderedLines) {
    lines.push(...wrapTranscriptText(outputLine, contentWidth, indent));
  }

  if (step.outputTruncated) {
    lines.push(...wrapTranscriptText("Output truncated to the latest 200 lines.", contentWidth, indent));
  }

  return lines;
}

function buildApprovalTranscriptLines(
  block: Extract<RendererAgentTurn["inlineBlock"], { kind: "approval" }>,
  contentWidth: number,
  indent: string,
): string[] {
  const lines = [
    ...renderRichTextToTranscriptLines(block.title, contentWidth, indent),
  ];

  if (block.subtitle) {
    lines.push(...renderRichTextToTranscriptLines(block.subtitle, contentWidth, indent));
  }

  block.options.forEach((option, index) => {
    lines.push(...wrapPrefixedTranscriptLine(
      index === block.selectedIndex ? "> " : "  ",
      option.label,
      contentWidth,
      indent,
    ));
    lines.push(...wrapTranscriptText(option.description, contentWidth, `${indent}  `));
  });

  return lines;
}

function buildDiffTranscriptLines(
  block: Extract<RendererAgentTurn["inlineBlock"], { kind: "diff" }>,
  contentWidth: number,
  indent: string,
): string[] {
  const visibleLines = block.lines.slice(
    block.scrollOffset,
    block.scrollOffset + block.viewportHeight,
  );
  const scrollEnd = Math.min(
    block.lines.length,
    block.scrollOffset + block.viewportHeight,
  );
  const lines = [
    ...renderRichTextToTranscriptLines(block.title, contentWidth, indent),
  ];

  if (block.subtitle) {
    lines.push(...renderRichTextToTranscriptLines(block.subtitle, contentWidth, indent));
  }

  lines.push(...renderRichTextToTranscriptLines(block.summary, contentWidth, indent));
  lines.push(...wrapTranscriptText(
    `Changed ${block.changeSummary.changedLines}  Added ${block.changeSummary.addedLines}  Removed ${block.changeSummary.removedLines}`,
    contentWidth,
    indent,
  ));

  if (block.truncated) {
    lines.push(...wrapTranscriptText("Preview truncated to the first diff lines.", contentWidth, indent));
  }

  lines.push(...wrapTranscriptText(
    `Showing lines ${block.scrollOffset + 1}-${scrollEnd} of ${block.lines.length}`,
    contentWidth,
    indent,
  ));

  for (const line of visibleLines) {
    const marker = line.kind === "add"
      ? "+"
      : line.kind === "remove"
        ? "-"
        : " ";
    lines.push(...wrapTranscriptText(
      `${marker} ${formatDiffLineNumber(line.oldLineNumber)} ${formatDiffLineNumber(line.newLineNumber)} ${line.text}`,
      contentWidth,
      indent,
    ));
  }

  return lines;
}

function renderRendererLineToTranscriptLines(
  line: RendererLine,
  contentWidth: number,
  indent: string,
): string[] {
  switch (line.kind) {
    case "section":
      return wrapTranscriptText(line.text, contentWidth, indent);
    case "error":
      return wrapPrefixedTranscriptLine("error: ", line.text, contentWidth, indent);
    case "warning":
    case "body":
    case "info":
    default:
      return renderRichTextToTranscriptLines(line.text, contentWidth, indent);
  }
}

function renderRichTextToTranscriptLines(
  text: string,
  contentWidth: number,
  indent: string,
): string[] {
  const lines: string[] = [];
  const availableWidth = Math.max(1, contentWidth - getDisplayWidth(indent));
  const blocks = parseAssistantRichText(text);

  for (const block of blocks) {
    switch (block.kind) {
      case "blank":
        lines.push(indent);
        break;
      case "heading":
        lines.push(...wrapTranscriptText(
          `${"#".repeat(block.level)} ${inlineSegmentsToPlainText(block.segments)}`,
          contentWidth,
          indent,
        ));
        break;
      case "quote":
        lines.push(...wrapPrefixedTranscriptLine("> ", inlineSegmentsToPlainText(block.segments), contentWidth, indent));
        break;
      case "list_item":
        lines.push(...wrapPrefixedTranscriptLine(`${block.marker} `, inlineSegmentsToPlainText(block.segments), contentWidth, indent));
        break;
      case "code_block":
        lines.push(...wrapTranscriptText(`\`\`\`${block.language ?? ""}`, contentWidth, indent));
        for (const codeLine of block.code.split("\n")) {
          lines.push(...wrapPrefixedTranscriptLine("| ", codeLine, contentWidth, indent));
        }
        lines.push(...wrapTranscriptText("```", contentWidth, indent));
        break;
      case "table":
        for (const tableLine of renderMarkdownTableLines({
          headers: block.headers,
          rows: block.rows,
          alignments: block.alignments,
        }, availableWidth)) {
          lines.push(...wrapTranscriptText(tableLine, contentWidth, indent));
        }
        break;
      case "paragraph":
      default:
        lines.push(...wrapTranscriptText(
          inlineSegmentsToPlainText(block.segments),
          contentWidth,
          indent,
        ));
        break;
    }
  }

  return lines.length === 0 ? [indent] : lines;
}

function inlineSegmentsToPlainText(
  segments: Array<{ text: string }>,
): string {
  return segments.map((segment) => segment.text).join("");
}

function wrapPrefixedTranscriptLine(
  prefix: string,
  text: string,
  contentWidth: number,
  indent: string,
): string[] {
  const indentWidth = getDisplayWidth(indent);
  const prefixWidth = getDisplayWidth(prefix);
  const availableWidth = Math.max(1, contentWidth - indentWidth - prefixWidth);
  const wrapped = wrapTerminalText(text, availableWidth);

  return wrapped.map((line, index) => `${indent}${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`);
}

function wrapTranscriptText(
  text: string,
  contentWidth: number,
  indent: string,
): string[] {
  const availableWidth = Math.max(1, contentWidth - getDisplayWidth(indent));
  return wrapTerminalText(text, availableWidth).map((line) => `${indent}${line}`);
}

function wrapTerminalText(text: string, width: number): string[] {
  if (!text) {
    return [""];
  }

  const lines: string[] = [];
  let currentLine = "";

  for (const character of text) {
    const nextLine = `${currentLine}${character}`;
    if (getDisplayWidth(nextLine) > width && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = character;
      continue;
    }

    currentLine = nextLine;
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
}

function getTranscriptLineColor(line: string): string | undefined {
  if (line.startsWith("stderr |") || line.startsWith("- ")) {
    return "redBright";
  }

  if (line.startsWith("+ ")) {
    return "green";
  }

  if (line.startsWith("> ")) {
    return "cyan";
  }

  if (line.startsWith("^ ") || line.startsWith("v ")) {
    return "yellow";
  }

  return undefined;
}

function isTranscriptLineDim(line: string): boolean {
  return (
    line.startsWith("stdout |") ||
    line.startsWith("cwd: ") ||
    line.startsWith("^ ") ||
    line.startsWith("v ") ||
    line === "(waiting for output)"
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
  isFirst: boolean;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle={props.isLatest ? "round" : undefined}
      borderColor={props.isLatest ? "white" : undefined}
      marginTop={props.isFirst ? 0 : 1}
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
  isFirst: boolean;
  commandViewportHeight: number;
  contentWidth: number;
}): React.JSX.Element {
  const activeCommandStep = [...props.turn.steps].reverse().find((step) =>
    step.kind === "command" && step.status === "running"
  ) ?? null;
  const isFocused = props.isLatest || props.turn.status !== "completed";
  const showLockedPromptStyle =
    props.turn.status === "running_tools" || props.turn.status === "streaming_answer";
  const workingSpinnerFrame = useSpinnerFrame({
    enabled: showLockedPromptStyle,
    frames: WORKING_SPINNER_FRAMES,
  });
  const showStepDetails = isFocused;
  const showAnswer = isFocused || props.turn.answerText.length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle={isFocused ? "round" : undefined}
      borderColor={isFocused ? getTurnBorderColor(props.turn.status) : undefined}
      marginTop={props.isFirst ? 0 : 1}
      paddingX={1}
      marginLeft={isFocused ? 0 : 2}
    >
      <Box
        flexDirection="row"
        marginBottom={1}
        paddingX={showLockedPromptStyle ? 1 : 0}
        backgroundColor={showLockedPromptStyle ? "blackBright" : undefined}
      >
        {showLockedPromptStyle ? (
          <Text color="gray">{`${workingSpinnerFrame} `}</Text>
        ) : null}
        <Text
          bold
          color={showLockedPromptStyle ? "gray" : isFocused ? "cyan" : "white"}
          dimColor={!showLockedPromptStyle && !isFocused}
        >
          {"> "}
        </Text>
        <Text
          {...(showLockedPromptStyle ? { color: "white" as const } : {})}
          dimColor={!showLockedPromptStyle && !isFocused}
        >
          {fitSingleLine(props.turn.promptText, Math.max(1, props.contentWidth - 6))}
        </Text>
      </Box>

      {props.turn.steps.length > 0 && showStepDetails ? (
        <Box flexDirection="column">
          {props.turn.steps.map((step) => (
            <ToolStepSummary
              key={step.id}
              step={step}
              isActive={activeCommandStep?.id === step.id}
              dimmed={!isFocused}
              width={props.contentWidth}
            />
          ))}
        </Box>
      ) : null}

      {props.turn.steps.length > 0 && !showStepDetails ? (
        <HistorySummary steps={props.turn.steps} width={props.contentWidth} />
      ) : null}

      {activeCommandStep ? (
        <CommandPanel
          step={activeCommandStep}
          viewportHeight={props.commandViewportHeight}
          width={props.contentWidth}
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
            <AssistantRichText text={props.turn.answerText} maxWidth={props.contentWidth} />
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
  width: number;
}): React.JSX.Element {
  const statusColor = getStepColor(props.step);
  const spinnerFrame = useSpinnerFrame({
    enabled: props.isActive,
  });
  const marker = props.isActive
    ? `${spinnerFrame} `
    : props.step.kind === "notice"
      ? "! "
      : "- ";

  return (
    <Box flexDirection="row">
      <Text color={statusColor} dimColor={props.dimmed}>{marker}</Text>
      <Text color={statusColor} dimColor={props.dimmed}>
        {fitSingleLine(`${props.step.title}  ${props.step.summary}`, Math.max(1, props.width - 2))}
      </Text>
    </Box>
  );
}

function HistorySummary(props: { steps: RendererToolStep[]; width?: number }): React.JSX.Element {
  const lastStep = props.steps[props.steps.length - 1] ?? null;
  const completedCount = props.steps.filter((step) => step.status === "completed").length;
  const failedCount = props.steps.filter((step) => step.status === "failed" || step.status === "timed_out").length;

  return (
    <Text dimColor>
      {fitSingleLine(
        `${props.steps.length} step${props.steps.length === 1 ? "" : "s"}  completed ${completedCount}  failed ${failedCount}${lastStep ? `  last ${lastStep.title}` : ""}`,
        props.width ?? 80,
      )}
    </Text>
  );
}

function CommandPanel(props: {
  step: RendererToolStep;
  viewportHeight: number;
  width: number;
}): React.JSX.Element {
  const spinnerFrame = useSpinnerFrame({
    enabled: true,
  });
  const visibleLines = props.step.outputLines.slice(-props.viewportHeight);
  const renderedLines = visibleLines.length === 0
    ? ["(waiting for output)"]
    : visibleLines;
  // Keep the panel height stable while output streams so the surrounding
  // layout does not jump up and down on every new line.
  const paddingLineCount = Math.max(0, props.viewportHeight - renderedLines.length);

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
        <Text color="cyan">{fitSingleLine(props.step.command ?? "command", Math.max(1, props.width - 4))}</Text>
      </Box>
      <Text dimColor>
        {fitSingleLine(
          `cwd: ${props.step.cwd ?? "."}  category: ${props.step.category ?? "unknown"}  status: ${formatStepStatus(props.step)}`,
          Math.max(1, props.width - 2),
        )}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {renderedLines.map((line, index) => (
          <Text
            key={`output-${props.step.id}-${index}-${line}`}
            color={line.startsWith("stderr |") ? "redBright" : "white"}
            dimColor={line === "(waiting for output)" || line.startsWith("stdout |")}
          >
            {fitSingleLine(line, Math.max(1, props.width - 2))}
          </Text>
        ))}
        {Array.from({ length: paddingLineCount }, (_, index) => (
          <Text key={`output-pad-${props.step.id}-${index}`}> </Text>
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

// Stable-height suggestion area: cap rendered lines to MAX_SUGGESTION_LINES
// and pad the remainder so the composer never changes height from suggestions.
const MAX_SUGGESTION_LINES = 7;

// Build the top divider for the Composer. When context meter data is
// available, embed a compact summary like "── context 1.4k/262.1k (0.5%) ──"
// so the user can still see context usage even when the header has scrolled
// off-screen during long agent output.
function buildContextDivider(
  meter: RendererContextMeter | null,
  width: number,
): React.JSX.Element {
  if (!meter) {
    return <Text dimColor>{"─".repeat(width)}</Text>;
  }

  const toneProps = getContextToneTextProps(meter.display.tone);
  const fullLabel = meter.modelLabel
    ? `${meter.modelLabel} · ctx ${meter.display.usageText} (${meter.display.percentText})`
    : `ctx ${meter.display.usageText} (${meter.display.percentText})`;
  const compactLabel = `ctx ${meter.display.usageText} (${meter.display.percentText})`;
  const fallbackLabel = `ctx ${meter.display.usageText}`;
  const label = ` ${pickContextDividerLabel(Math.max(1, width - 2), [fullLabel, compactLabel, fallbackLabel])} `;
  const labelWidth = getDisplayWidth(label);
  const remainingDashes = Math.max(0, width - labelWidth);
  const leftDashes = Math.floor(remainingDashes / 2);
  const rightDashes = remainingDashes - leftDashes;

  return (
    <Text dimColor>
      {"─".repeat(leftDashes)}
      <Text {...toneProps} dimColor={false}>{label}</Text>
      {"─".repeat(rightDashes)}
    </Text>
  );
}

function Composer(props: {
  prompt: RendererPrompt;
  divider: string;
  inputMode: InteractiveShellProps["inputMode"];
  contextMeter: RendererContextMeter | null;
}): React.JSX.Element {
  const availableWidth = props.divider.length;
  const isActive = props.inputMode === "prompt";
  const contextDivider = buildContextDivider(props.contextMeter, availableWidth);

  // When inactive, render the same structural lines but dimmed to avoid
  // mounting/unmounting jitter while signalling that input is unavailable.
  if (!isActive) {
    return (
      <Box flexDirection="column">
        {contextDivider}
        <Text dimColor color="gray">{fitSingleLine("  ...", availableWidth)}</Text>
        <Text dimColor>{"─".repeat(availableWidth)}</Text>
      </Box>
    );
  }

  const suggestionLines = renderSuggestionLines(props.prompt.state);
  const visibleSuggestions = suggestionLines.slice(0, MAX_SUGGESTION_LINES);
  // Pad to a fixed height only while a suggestion session is active
  // (@file or /command). This avoids blank space during normal typing
  // while keeping height stable when suggestions change within a session.
  const inSuggestionSession =
    props.prompt.state.activeReference !== null ||
    props.prompt.state.activeSlashCommand !== null;
  const paddingCount = inSuggestionSession
    ? Math.max(0, MAX_SUGGESTION_LINES - visibleSuggestions.length)
    : 0;

  return (
    <Box flexDirection="column">
      {contextDivider}
      <PromptLine
        label={props.prompt.label}
        state={props.prompt.state}
        isActive
        availableWidth={availableWidth}
      />
      {props.prompt.state.errorMessage ? (
        <Text color="redBright">{fitSingleLine(`  ${props.prompt.state.errorMessage}`, availableWidth)}</Text>
      ) : null}
      {visibleSuggestions.map((line, index) => (
        <Text
          key={`suggestion-${line.text}-${index}`}
          dimColor={!line.selected}
          inverse={line.selected}
        >
          {fitSingleLine(line.text, availableWidth)}
        </Text>
      ))}
      {Array.from({ length: paddingCount }, (_, index) => (
        <Text key={`suggestion-pad-${index}`}>{" "}</Text>
      ))}
      <Text dimColor>{"─".repeat(availableWidth)}</Text>
    </Box>
  );
}

function PromptLine(props: {
  label: RendererPrompt["label"];
  state: ComposerState;
  isActive: boolean;
  availableWidth: number;
}): React.JSX.Element {
  const labelWidth = getDisplayWidth(props.label.text);
  const contentWidth = Math.max(1, props.availableWidth - labelWidth);
  const viewport = buildPromptViewport(props.state.buffer, props.state.cursorIndex, contentWidth);

  return (
    <Box flexDirection="row">
      <Text bold color={props.label.kind === "editor" ? "yellow" : "cyan"}>
        {props.label.text}
      </Text>
      {props.isActive
        ? (
            <Text>
              {viewport.beforeCursor}
            </Text>
          )
        : <Text dimColor>{fitSingleLine(props.state.buffer, contentWidth)}</Text>}
      {props.isActive ? <Text inverse>{viewport.cursorCharacter}</Text> : null}
      {props.isActive ? <Text>{viewport.afterCursor}</Text> : null}
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

function OverlayViewer(props: { overlay: RendererViewerOverlay }): React.JSX.Element {
  const visibleLines = props.overlay.lines.slice(
    props.overlay.scrollOffset,
    props.overlay.scrollOffset + props.overlay.viewportHeight,
  );
  // Keep the viewer box height stable while avoiding raw JSX whitespace
  // nodes, which Ink rejects unless they are wrapped in <Text>.
  const paddingCount = Math.max(0, props.overlay.viewportHeight - visibleLines.length);
  const scrollEnd = Math.min(
    props.overlay.lines.length,
    props.overlay.scrollOffset + props.overlay.viewportHeight,
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      marginTop={1}
      paddingX={1}
      paddingY={0}
    >
      <RichText text={props.overlay.title} />
      {props.overlay.subtitle ? <RichText text={props.overlay.subtitle} tone="info" /> : null}
      {props.overlay.lines.length === 0
        ? <RichText text={props.overlay.emptyMessage ?? "Nothing to show."} tone="info" />
        : (
            <>
              <RichText
                text={`Showing lines ${props.overlay.scrollOffset + 1}-${scrollEnd} of ${props.overlay.lines.length}`}
                tone="info"
              />
              <Box flexDirection="column" marginTop={1}>
                {visibleLines.map((line, index) => (
                  <ViewerLine
                    key={`viewer-${props.overlay.scrollOffset + index}-${line.text}`}
                    line={line}
                  />
                ))}
                {Array.from({ length: paddingCount }, (_, index) => (
                  <Text key={`viewer-pad-${index}`}>{" "}</Text>
                ))}
              </Box>
            </>
          )}
    </Box>
  );
}

function StatusBar(props: { text: string; width: number }): React.JSX.Element {
  return <Text dimColor>{fitSingleLine(props.text, props.width)}</Text>;
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
  if (props.line.color || props.line.dimColor !== undefined) {
    return (
      <Text
        {...(props.line.color ? { color: props.line.color } : {})}
        dimColor={props.line.dimColor ?? false}
      >
        {text}
      </Text>
    );
  }

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

function pickContextDividerLabel(width: number, labels: string[]): string {
  for (const label of labels) {
    if (getDisplayWidth(label) <= width) {
      return label;
    }
  }

  return truncateForTerminal(labels[labels.length - 1] ?? "", Math.max(1, width));
}

function buildContextBarCells(
  width: number,
  ratio: number | null,
): {
  filled: string;
  empty: string;
} {
  const clampedWidth = Math.max(0, width);
  if (clampedWidth === 0) {
    return { filled: "", empty: "" };
  }

  const safeRatio = ratio === null ? 0 : Math.max(0, Math.min(ratio, 1));
  const filledWidth = safeRatio <= 0
    ? 0
    : Math.min(clampedWidth, Math.max(1, Math.ceil(clampedWidth * safeRatio)));

  return {
    filled: "▰".repeat(filledWidth),
    empty: "▱".repeat(Math.max(0, clampedWidth - filledWidth)),
  };
}

function getContextToneTextProps(
  tone: ContextIndicatorTone,
): {
  color?: string;
  dimColor?: boolean;
} {
  switch (tone) {
    case "notice":
      return { color: "yellow" };
    case "warning":
      return { color: "red" };
    case "critical":
      return { color: "redBright" };
    case "muted":
    default:
      return { color: "gray", dimColor: true };
  }
}

function ViewerLine(props: {
  line: RendererViewerOverlay["lines"][number];
}): React.JSX.Element {
  const content = props.line.format === "plain"
    ? <PlainViewerText line={props.line} />
    : renderViewerRichText(props.line);

  if (!props.line.indent || props.line.indent <= 0) {
    return content;
  }

  return <Box marginLeft={props.line.indent}>{content}</Box>;
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

function renderViewerRichText(
  line: RendererViewerOverlay["lines"][number],
): React.JSX.Element {
  switch (line.tone) {
    case "error":
      return <RichText text={line.text} tone="error" />;
    case "warning":
      return <RichText text={line.text} tone="warning" />;
    case "info":
      return <RichText text={line.text} tone="info" />;
    case "default":
    default:
      return <RichText text={line.text} />;
  }
}

function PlainViewerText(props: {
  line: RendererViewerOverlay["lines"][number];
}): React.JSX.Element {
  const text = props.line.text.length === 0 ? " " : props.line.text;

  switch (props.line.tone) {
    case "error":
      return <Text color="redBright">{text}</Text>;
    case "warning":
      return <Text color="#ff8c42">{text}</Text>;
    case "info":
      return <Text dimColor>{text}</Text>;
    case "default":
    default:
      return <Text>{text}</Text>;
  }
}

function renderSuggestionLines(state: ComposerState): Array<{
  text: string;
  selected: boolean;
}> {
  if (state.activeReference !== null) {
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

  if (state.activeSlashCommand !== null) {
    if (state.suggestions.length === 0) {
      return [{ text: `  No commands match "/${state.activeSlashCommand.query}".`, selected: false }];
    }

    return [
      {
        text: "  / commands - Up/Down to choose, Enter or Tab to insert",
        selected: false,
      },
      ...state.suggestions.map((match, index) => ({
        text: `${index === state.selectedSuggestionIndex ? ">" : " "} ${match}`,
        selected: index === state.selectedSuggestionIndex,
      })),
    ];
  }

  return [];
}

function fitSingleLine(text: string, width: number): string {
  return truncateForTerminal(text.replace(/\r?\n/g, " "), Math.max(1, width));
}

function buildPromptViewport(
  buffer: string,
  cursorIndex: number,
  availableWidth: number,
): {
  beforeCursor: string;
  cursorCharacter: string;
  afterCursor: string;
} {
  const safeCursorIndex = Math.min(Math.max(cursorIndex, 0), buffer.length);
  const rawCursorCharacter = buffer.slice(safeCursorIndex, safeCursorIndex + 1);
  const cursorCharacter = rawCursorCharacter || " ";
  const cursorWidth = Math.max(1, getDisplayWidth(cursorCharacter));
  const contentWidth = Math.max(cursorWidth, availableWidth);

  let start = 0;
  let end = buffer.length;

  const buildWindow = () => {
    const prefix = start > 0 ? "…" : "";
    const suffix = end < buffer.length ? "…" : "";
    return {
      beforeCursor: `${prefix}${buffer.slice(start, safeCursorIndex)}`,
      cursorCharacter,
      afterCursor: `${buffer.slice(safeCursorIndex + rawCursorCharacter.length, end)}${suffix}`,
    };
  };

  while (true) {
    const window = buildWindow();
    const width =
      getDisplayWidth(window.beforeCursor) +
      cursorWidth +
      getDisplayWidth(window.afterCursor);

    if (width <= contentWidth) {
      return window;
    }

    const removableLeft = safeCursorIndex - start;
    const removableRight = end - (safeCursorIndex + rawCursorCharacter.length);

    if (removableRight > removableLeft && removableRight > 0) {
      end -= 1;
      continue;
    }

    if (removableLeft > 0) {
      start += 1;
      continue;
    }

    if (removableRight > 0) {
      end -= 1;
      continue;
    }

    return {
      beforeCursor: "",
      cursorCharacter,
      afterCursor: "",
    };
  }
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
