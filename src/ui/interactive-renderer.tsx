import { emitKeypressEvents, type Key as ReadlineKey } from "node:readline";
import type { Writable } from "node:stream";
import type { Key } from "ink";
import type {
  CommandApprovalDecision,
  CommandCategory,
  ToolTurnEvent,
  WorkspaceEditChangeSummary,
  WorkspaceEditDiffPreviewLine,
} from "../tools/types.js";
import type { ContextIndicatorDisplay } from "./context-indicator.js";
import {
  applySelectedComposerSuggestion,
  backspaceComposerText,
  clearComposerError,
  createComposerState,
  deleteComposerText,
  insertComposerText,
  moveComposerCursor,
  moveComposerSuggestionSelection,
  submitComposer,
  syncComposerState,
  type ComposerState,
} from "./composer-state.js";
import { renderInteractiveShellDocument } from "./ink/interactive-shell.js";
import { normalizeInkInput } from "./input-events.js";
import { createTerminalScreen } from "./terminal-screen.js";

export type RendererLine = {
  id: string;
  kind: "info" | "error" | "warning" | "section" | "body";
  text: string;
  color?: string;
  dimColor?: boolean;
};

export type RendererContextMeter = {
  usedTokens: number | null;
  limitTokens: number | null;
  source: "response" | "estimate" | null;
  display: ContextIndicatorDisplay;
  modelLabel: string | null;
};

export type RendererShellFrame = {
  title: string;
  workspaceLines: RendererLine[];
  statusLines: RendererLine[];
  noticeLines: RendererLine[];
  planLines: RendererLine[];
  footerLines: RendererLine[];
  contextMeter: RendererContextMeter | null;
};

export type RendererPrompt = {
  label: {
    kind: "user" | "editor";
    text: string;
  };
  state: ComposerState;
  kind: "primary" | "auxiliary";
};

export type RendererPickerOption = {
  value: string | null;
  label: string;
  description: string;
  tone?: "default" | "accent" | "danger";
};

export type RendererSelectOptions = {
  title: string;
  subtitle?: string;
  helpText?: string;
  emptyMessage?: string;
  options: RendererPickerOption[];
};

export type RendererOverlayOption = {
  value: string | null;
  label: string;
  description: string;
  tone: "default" | "accent" | "danger";
};

export type RendererViewerLine = {
  text: string;
  tone?: "default" | "info" | "warning" | "error";
  format?: "rich_text" | "plain";
  indent?: number;
};

export type RendererPickerOverlay = {
  kind: "picker";
  title: string;
  subtitle: string | null;
  helpText: string | null;
  emptyMessage: string | null;
  options: RendererOverlayOption[];
  selectedIndex: number;
};

export type RendererViewerOverlay = {
  kind: "viewer";
  title: string;
  subtitle: string | null;
  helpText: string | null;
  emptyMessage: string | null;
  lines: RendererViewerLine[];
  scrollOffset: number;
  viewportHeight: number;
};

export type RendererOverlay = RendererPickerOverlay | RendererViewerOverlay;

export type RendererInlineApprovalOption = {
  value: CommandApprovalDecision;
  label: string;
  description: string;
  tone: "default" | "accent" | "danger";
};

export type RendererInlineApprovalBlock = {
  kind: "approval";
  title: string;
  subtitle: string | null;
  helpText: string | null;
  options: RendererInlineApprovalOption[];
  selectedIndex: number;
};

export type RendererDiffBlock = {
  kind: "diff";
  mode: "approval" | "review";
  title: string;
  subtitle: string | null;
  helpText: string | null;
  summary: string;
  changeSummary: WorkspaceEditChangeSummary;
  truncated: boolean;
  lines: WorkspaceEditDiffPreviewLine[];
  scrollOffset: number;
  viewportHeight: number;
};

export type RendererInlineBlock = RendererInlineApprovalBlock | RendererDiffBlock;

export type RendererDiffApprovalOptions = {
  title: string;
  subtitle?: string;
  helpText?: string;
  summary: string;
  changeSummary: WorkspaceEditChangeSummary;
  truncated?: boolean;
  lines: WorkspaceEditDiffPreviewLine[];
};

export type RendererApprovalOptions = {
  title: string;
  subtitle?: string;
  helpText?: string;
  options: RendererInlineApprovalOption[];
};

export type RendererViewerOptions = {
  title: string;
  subtitle?: string;
  helpText?: string;
  emptyMessage?: string;
  lines: RendererViewerLine[];
};

export type RendererToolStep = {
  id: string;
  kind: "command" | "workspace_edit" | "notice";
  title: string;
  summary: string;
  status: "running" | "completed" | "failed" | "timed_out";
  command: string | null;
  cwd: string | null;
  category: CommandCategory | null;
  path: string | null;
  outputLines: string[];
  outputRemainder: string;
  outputTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stream: "stdout" | "stderr" | null;
  startedAtMs: number | null;
};

export type InteractiveRendererTraceEvent =
  | {
      kind: "shell_frame";
      title: string;
      workspaceLines: string[];
      statusLines: string[];
      noticeLines: string[];
      planLines: string[];
      footerLines: string[];
    }
  | {
      kind: "info" | "error" | "warning" | "body";
      message: string;
    }
  | {
      kind: "prompt_requested";
      label: string;
      promptKind: "primary" | "auxiliary";
      workspaceFileCount: number;
    }
  | {
      kind: "prompt_submitted";
      value: string;
    }
  | {
      kind: "overlay_requested";
      overlayKind: "picker" | "viewer" | "approval" | "diff_approval" | "diff_review";
      title: string;
    }
  | {
      kind: "overlay_resolved";
      overlayKind: "picker" | "viewer" | "approval" | "diff_approval" | "diff_review";
      value: string | null;
    }
  | {
      kind: "turn_started";
      promptText: string;
    }
  | {
      kind: "assistant_chunk";
      chunk: string;
    }
  | {
      kind: "turn_completed";
    }
  | {
      kind: "turn_failed";
      message: string;
    }
  | {
      kind: "tool_event";
      event: ToolTurnEvent;
    };

export type RendererAgentTurn = {
  id: string;
  kind: "agent";
  status:
    | "collecting_input"
    | "running_tools"
    | "awaiting_approval"
    | "streaming_answer"
    | "completed"
    | "failed";
  promptText: string;
  steps: RendererToolStep[];
  answerText: string;
  inlineBlock: RendererInlineBlock | null;
};

export type RendererSystemTurn = {
  id: string;
  kind: "system";
  lines: RendererLine[];
};

export type RendererTurnCard = RendererAgentTurn | RendererSystemTurn;

export type RendererTranscriptViewport = {
  followLatest: boolean;
  scrollOffsetLines: number;
  pendingBelowLines: number;
  totalLines: number;
  viewportHeight: number;
  maxScrollOffsetLines: number;
  hiddenAboveLines: number;
  hiddenBelowLines: number;
};

export type InteractiveRenderer = {
  promptLabel: string;
  editorPromptLabel: string;
  setActiveRequestCancel: (cancel: (() => void) | null) => void;
  setActiveRequestInterrupt: (interrupt: (() => void) | null) => void;
  setMinimumCommandPanelDurationMs: (durationMs: number) => void;
  setPromptLabel: (promptLabel: string) => void;
  setShellFrame: (frame: {
    title: string;
    workspaceLines: Array<Omit<RendererLine, "id">>;
    statusLines: Array<Omit<RendererLine, "id">>;
    noticeLines: Array<Omit<RendererLine, "id">>;
    planLines: Array<Omit<RendererLine, "id">>;
    footerLines: Array<Omit<RendererLine, "id">>;
    contextMeter?: RendererContextMeter | null;
  }) => void;
  renderCommands: () => void;
  renderSectionTitle: (title: string) => void;
  renderInfo: (message: string) => void;
  renderError: (message: string) => void;
  renderWarning: (message: string) => void;
  writeBodyLine: (message: string) => void;
  beginAgentTurn: (promptText: string) => void;
  appendAssistantChunk: (chunk: string) => void;
  completeActiveTurn: () => void;
  failActiveTurn: (message: string) => void;
  applyToolEvent: (event: ToolTurnEvent) => void;
  clearScreen: () => void;
  readPrompt: (options: {
    promptLabel: string;
    promptKind?: "primary" | "auxiliary";
    workspaceFiles: string[];
  }) => Promise<string>;
  selectOption: (options: RendererSelectOptions) => Promise<string | null>;
  viewText: (options: RendererViewerOptions) => Promise<void>;
  requestApproval: (options: RendererApprovalOptions) => Promise<CommandApprovalDecision>;
  reviewDiff: (options: RendererDiffApprovalOptions) => Promise<CommandApprovalDecision>;
  viewDiff: (options: RendererDiffApprovalOptions) => Promise<void>;
  getSnapshot: () => InteractiveRendererSnapshot;
  dispatchInput: (
    inputValue: string,
    key: Parameters<typeof normalizeInkInput>[1],
  ) => void;
  suspend: () => void;
  resume: () => void;
  dispose: () => void;
};

type RendererInputMode = "inactive" | "prompt" | "overlay" | "inline";

type RendererState = {
  shellFrame: RendererShellFrame;
  turns: RendererTurnCard[];
  prompt: RendererPrompt;
  inputMode: RendererInputMode;
  overlay: RendererOverlay | null;
  transcriptViewport: RendererTranscriptViewport;
  canCancelActiveRequest: boolean;
  canInterruptActiveRequest: boolean;
};

export type InteractiveRendererSnapshot = {
  shellFrame: RendererShellFrame;
  turns: RendererTurnCard[];
  prompt: RendererPrompt;
  inputMode: RendererInputMode;
  inputActive: boolean;
  overlay: RendererOverlay | null;
  transcriptViewport: RendererTranscriptViewport;
  statusText: string;
};

const MAX_COMMAND_OUTPUT_LINES = 200;
const ASSISTANT_ANIMATION_CHUNK_SIZE = 8;
// Flush interval for animated assistant text. A higher value means fewer
// re-renders per second which reduces visual jitter during streaming.
const ASSISTANT_ANIMATION_INTERVAL_MS = 32;
const DEFAULT_MIN_COMMAND_PANEL_DURATION_MS = 1_000;

export function createInteractiveRenderer(options: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  enableInput?: boolean;
  minCommandPanelDurationMs?: number;
  onShortcut?: (shortcut: "toggle_plan_mode") => void;
  traceEvent?: (event: InteractiveRendererTraceEvent) => void;
}): InteractiveRenderer {
  const promptLabel = "> ";
  const editorPromptLabel = "system > ";
  let nextLineId = 0;
  let nextTurnId = 0;
  let promptWorkspaceFiles: string[] = [];
  let promptResolver: ((value: string) => void) | null = null;
  let overlayResolver: ((value: string | null) => void) | null = null;
  let inlineApprovalResolver: ((value: CommandApprovalDecision) => void) | null = null;
  let diffResolver: ((value: CommandApprovalDecision) => void) | null = null;
  let diffReviewResolver: (() => void) | null = null;
  let activeRequestCancel: (() => void) | null = null;
  let activeRequestInterrupt: (() => void) | null = null;
  let assistantAnimationTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAssistantChunks: string[] = [];
  let pendingTurnStatus: RendererAgentTurn["status"] | null = null;
  let assistantFlushResolvers: Array<() => void> = [];
  let minCommandPanelDurationMs = normalizeMinimumCommandPanelDurationMs(
    options.minCommandPanelDurationMs,
  );
  const pendingCommandCompletionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let pendingToolOutputEvents: ToolTurnEvent[] = [];
  let toolOutputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const emitTrace = (event: InteractiveRendererTraceEvent) => {
    options.traceEvent?.(event);
  };
  // The shell now renders offscreen into a fixed-height document and writes it
  // through our own line-diff surface. This avoids Ink's fullscreen path,
  // which clears the terminal whenever output height reaches the TTY height.
  const screen = createTerminalScreen(options.output);
  const inputEnabled = options.enableInput ?? true;
  const shouldAnimateAssistantText = options.enableInput ?? true;
  let spinnerTick = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let mounted = false;
  let inputAttached = false;
  let keypressEventsInitialized = false;
  let state: RendererState = {
    shellFrame: {
      title: "SuperRun",
      workspaceLines: [],
      statusLines: [],
      noticeLines: [],
      planLines: [],
      footerLines: [],
      contextMeter: null,
    },
    turns: [],
    prompt: {
      label: {
        kind: "user",
        text: promptLabel,
      },
      state: createComposerState(),
      kind: "primary",
    },
    inputMode: "inactive",
    overlay: null,
    transcriptViewport: createInitialTranscriptViewport(
      getTranscriptViewportFallbackHeight(options.output),
    ),
    canCancelActiveRequest: false,
    canInterruptActiveRequest: false,
  };

  const mount = () => {
    if (mounted) {
      rerender();
      return;
    }

    mounted = true;
    attachInput();
    options.output.on?.("resize", handleResize);
    rerender();
  };

  const rerender = () => {
    if (!mounted) {
      return;
    }

    syncSpinnerTimer();
    const document = renderApp();
    screen.render(document.output, getShellHeight(options.output));
  };

  const renderApp = () => {
    const baseProps = {
      shellFrame: state.shellFrame,
      turns: state.turns,
      prompt: state.prompt,
      divider: buildDivider(options.output),
      shellHeight: getShellHeight(options.output),
      inputEnabled,
      inputMode: state.inputMode,
      overlay: state.overlay,
      statusText: buildStatusText(state),
      commandViewportHeight: getCommandViewportHeight(options.output),
      transcriptViewport: state.transcriptViewport,
      transcriptViewportFallbackHeight: getTranscriptViewportFallbackHeight(options.output),
      onInput: handleInput,
      onTranscriptViewportChange: () => {},
    };
    let document = renderInteractiveShellDocument({
      ...baseProps,
      spinnerTick,
    });
    const nextViewport = reconcileTranscriptViewport(
      state.transcriptViewport,
      document.transcriptViewport,
    );

    if (!rendererTranscriptViewportEquals(state.transcriptViewport, nextViewport)) {
      state = {
        ...state,
        transcriptViewport: nextViewport,
      };
      document = renderInteractiveShellDocument({
        ...baseProps,
        transcriptViewport: nextViewport,
        spinnerTick,
      });
    }

    return document;
  };

  const ensureSystemTurn = (): RendererSystemTurn => {
    const lastTurn = state.turns[state.turns.length - 1];
    if (lastTurn?.kind === "system") {
      return lastTurn;
    }

    const turn: RendererSystemTurn = {
      id: `turn_${nextTurnId += 1}`,
      kind: "system",
      lines: [],
    };
    state = {
      ...state,
      turns: [...state.turns, turn],
    };
    return turn;
  };

  const appendSystemLines = (
    kind: RendererLine["kind"],
    message: string,
  ) => {
    const lines = message.split(/\r?\n/);
    const turn = ensureSystemTurn();
    turn.lines.push(...lines.map((text) => ({
      id: `line_${nextLineId += 1}`,
      kind,
      text,
    })));
    rerender();
  };

  const getLatestAgentTurnIndex = (): number => [...state.turns].findLastIndex(
    (turn) => turn.kind === "agent",
  );

  const updateAgentTurn = (
    index: number,
    updater: (turn: RendererAgentTurn) => RendererAgentTurn,
  ): RendererAgentTurn | null => {
    const target = state.turns[index];
    if (!target || target.kind !== "agent") {
      return null;
    }

    const nextTurn = updater(target);
    const nextTurns = [...state.turns];
    nextTurns[index] = nextTurn;
    state = {
      ...state,
      turns: nextTurns,
    };
    return nextTurn;
  };

  const updateLatestAgentTurn = (
    updater: (turn: RendererAgentTurn) => RendererAgentTurn,
  ): RendererAgentTurn | null => {
    const index = getLatestAgentTurnIndex();
    return index === -1 ? null : updateAgentTurn(index, updater);
  };

  const getLatestAgentTurn = (): RendererAgentTurn | null => {
    const index = getLatestAgentTurnIndex();
    const turn = index === -1 ? null : state.turns[index];
    return turn?.kind === "agent" ? turn : null;
  };

  const finalizeCommandStepById = (
    stepId: string,
    event: Extract<ToolTurnEvent, { kind: "command_execution"; phase: "completed" }>,
  ) => {
    pendingCommandCompletionTimers.delete(stepId);
    const updated = updateLatestAgentTurn((turn) => {
      const targetIndex = turn.steps.findIndex((step) => step.id === stepId);
      if (targetIndex === -1) {
        return turn;
      }

      const nextSteps = [...turn.steps];
      const targetStep = nextSteps[targetIndex];
      if (!targetStep || targetStep.kind !== "command") {
        return turn;
      }

      nextSteps[targetIndex] = finalizeCommandStep(targetStep, event);
      return {
        ...turn,
        steps: nextSteps,
      };
    });

    if (updated) {
      rerender();
    }
  };

  // Apply a single tool event to the turn state with command-panel scheduling.
  // Returns true if the turn was updated.
  const applyToolEventImmediately = (event: ToolTurnEvent): boolean => {
    const result = updateLatestAgentTurn((turn) =>
      applyToolEventToTurn(turn, event, {
        minCommandPanelDurationMs,
        scheduleCommandCompletion: (stepId, completedEvent, remainingMs) => {
          const existingTimer = pendingCommandCompletionTimers.get(stepId);
          if (existingTimer) {
            clearTimeout(existingTimer);
          }

          pendingCommandCompletionTimers.set(
            stepId,
            setTimeout(() => {
              finalizeCommandStepById(stepId, completedEvent);
            }, remainingMs),
          );
        },
      }),
    );
    return result !== null;
  };

  // Drain all buffered output events in one batch and trigger a single rerender.
  const flushPendingToolOutputEvents = () => {
    if (toolOutputFlushTimer) {
      clearTimeout(toolOutputFlushTimer);
      toolOutputFlushTimer = null;
    }
    if (pendingToolOutputEvents.length === 0) {
      return;
    }
    const batch = pendingToolOutputEvents;
    pendingToolOutputEvents = [];

    let changed = false;
    for (const event of batch) {
      if (applyToolEventImmediately(event)) {
        changed = true;
      }
    }
    if (changed) {
      rerender();
    }
  };

  const setLatestAgentInlineBlock = (
    block: RendererInlineBlock | null,
    status?: RendererAgentTurn["status"],
    options?: {
      followLatest?: boolean;
    },
  ) => {
    if (options?.followLatest && !state.transcriptViewport.followLatest) {
      state = {
        ...state,
        transcriptViewport: {
          ...state.transcriptViewport,
          followLatest: true,
          scrollOffsetLines: state.transcriptViewport.maxScrollOffsetLines,
          pendingBelowLines: 0,
          hiddenBelowLines: 0,
        },
      };
    }

    const updated = updateLatestAgentTurn((turn) => ({
      ...turn,
      ...(status ? { status } : {}),
      inlineBlock: block,
    }));
    if (updated) {
      rerender();
    }
  };

  const resolveAssistantFlushWaiters = () => {
    if (pendingAssistantChunks.length > 0 || assistantAnimationTimer) {
      return;
    }

    const resolvers = assistantFlushResolvers;
    assistantFlushResolvers = [];
    for (const resolver of resolvers) {
      resolver();
    }
  };

  const finishPendingTurnStatusIfReady = () => {
    if (pendingAssistantChunks.length > 0 || assistantAnimationTimer || !pendingTurnStatus) {
      resolveAssistantFlushWaiters();
      return;
    }

    const status = pendingTurnStatus;
    pendingTurnStatus = null;
    const updated = updateLatestAgentTurn((turn) => ({
      ...turn,
      status: turn.status === "failed" ? "failed" : status,
    }));
    if (updated) {
      rerender();
    }
    if (status === "completed") {
      emitTrace({
        kind: "turn_completed",
      });
    }
    resolveAssistantFlushWaiters();
  };

  const flushNextAssistantChunk = () => {
    assistantAnimationTimer = null;

    // Drain all pending chunks in one frame to reduce re-render count.
    // This collapses many tiny updates into a single Ink render pass.
    if (pendingAssistantChunks.length === 0) {
      finishPendingTurnStatusIfReady();
      return;
    }

    const merged = pendingAssistantChunks.join("");
    pendingAssistantChunks.length = 0;

    const updated = updateLatestAgentTurn((turn) => ({
      ...turn,
      status: "streaming_answer",
      answerText: `${turn.answerText}${merged}`,
    }));
    if (updated) {
      rerender();
    }

    finishPendingTurnStatusIfReady();
  };

  const ensureAssistantAnimation = () => {
    if (assistantAnimationTimer || pendingAssistantChunks.length === 0) {
      if (pendingAssistantChunks.length === 0) {
        finishPendingTurnStatusIfReady();
      }
      return;
    }

    assistantAnimationTimer = setTimeout(
      flushNextAssistantChunk,
      ASSISTANT_ANIMATION_INTERVAL_MS,
    );
  };

  const appendAssistantTextImmediately = (chunk: string) => {
    const updated = updateLatestAgentTurn((turn) => ({
      ...turn,
      status: "streaming_answer",
      answerText: `${turn.answerText}${chunk}`,
    }));
    if (updated) {
      rerender();
    }
  };

  const waitForAssistantFlush = (): Promise<void> | null => {
    if (!shouldAnimateAssistantText || (pendingAssistantChunks.length === 0 && !assistantAnimationTimer)) {
      return null;
    }

    return new Promise<void>((resolve) => {
      assistantFlushResolvers.push(resolve);
    });
  };

  const resolvePrompt = (value: string) => {
    const resolver = promptResolver;
    promptResolver = null;
    state = {
      ...state,
      inputMode: "inactive",
    };
    rerender();
    emitTrace({
      kind: "prompt_submitted",
      value,
    });
    resolver?.(value);
  };

  const resolveOverlay = (value: string | null) => {
    const resolver = overlayResolver;
    const overlayKind = state.overlay?.kind === "picker"
      ? "picker"
      : "viewer";
    overlayResolver = null;
    state = {
      ...state,
      inputMode: "inactive",
      overlay: null,
    };
    rerender();
    emitTrace({
      kind: "overlay_resolved",
      overlayKind,
      value,
    });
    resolver?.(value);
  };

  const setActiveRequestCancel = (cancel: (() => void) | null) => {
    activeRequestCancel = cancel;
    if (state.canCancelActiveRequest === Boolean(cancel)) {
      return;
    }

    state = {
      ...state,
      canCancelActiveRequest: Boolean(cancel),
    };
    rerender();
  };

  const setActiveRequestInterrupt = (interrupt: (() => void) | null) => {
    activeRequestInterrupt = interrupt;
    if (state.canInterruptActiveRequest === Boolean(interrupt)) {
      return;
    }

    state = {
      ...state,
      canInterruptActiveRequest: Boolean(interrupt),
    };
    rerender();
  };

  const cancelActiveRequest = () => {
    const cancel = activeRequestCancel;
    if (!cancel) {
      return;
    }

    setActiveRequestCancel(null);
    cancel();
  };

  const interruptActiveRequest = () => {
    const interrupt = activeRequestInterrupt;
    if (!interrupt) {
      return;
    }

    setActiveRequestInterrupt(null);
    interrupt();
  };

  const resolveInlineApproval = (value: CommandApprovalDecision) => {
    const resolver = inlineApprovalResolver;
    inlineApprovalResolver = null;
    setLatestAgentInlineBlock(null, "running_tools");
    state = {
      ...state,
      inputMode: "inactive",
    };
    rerender();
    emitTrace({
      kind: "overlay_resolved",
      overlayKind: "approval",
      value,
    });
    resolver?.(value);
  };

  const resolveDiffApproval = (value: CommandApprovalDecision) => {
    const resolver = diffResolver;
    diffResolver = null;
    setLatestAgentInlineBlock(null, "running_tools");
    state = {
      ...state,
      inputMode: "inactive",
    };
    rerender();
    emitTrace({
      kind: "overlay_resolved",
      overlayKind: "diff_approval",
      value,
    });
    resolver?.(value);
  };

  const resolveDiffReview = () => {
    const resolver = diffReviewResolver;
    diffReviewResolver = null;
    const latestTurn = getLatestAgentTurn();
    setLatestAgentInlineBlock(null, latestTurn?.status === "failed" ? "failed" : "completed");
    state = {
      ...state,
      inputMode: "inactive",
    };
    rerender();
    emitTrace({
      kind: "overlay_resolved",
      overlayKind: "diff_review",
      value: null,
    });
    resolver?.();
  };

  const renderer: InteractiveRenderer = {
    promptLabel,
    editorPromptLabel,
    setActiveRequestCancel,
    setActiveRequestInterrupt,
    setMinimumCommandPanelDurationMs: (durationMs) => {
      minCommandPanelDurationMs = normalizeMinimumCommandPanelDurationMs(durationMs);
    },
    setPromptLabel: (nextPromptLabel) => {
      if (state.prompt.kind !== "primary") {
        return;
      }

      state = {
        ...state,
        prompt: {
          ...state.prompt,
          label: {
            ...state.prompt.label,
            text: nextPromptLabel,
          },
        },
      };
      rerender();
    },
    setShellFrame: (frame) => {
      state = {
        ...state,
        shellFrame: {
          title: frame.title,
          workspaceLines: frame.workspaceLines.map((line) => ({
            ...line,
            id: `header_${nextLineId += 1}`,
          })),
          statusLines: frame.statusLines.map((line) => ({
            ...line,
            id: `header_${nextLineId += 1}`,
          })),
          noticeLines: frame.noticeLines.map((line) => ({
            ...line,
            id: `header_${nextLineId += 1}`,
          })),
          planLines: (frame.planLines ?? []).map((line) => ({
            ...line,
            id: `header_${nextLineId += 1}`,
          })),
          footerLines: frame.footerLines.map((line) => ({
            ...line,
            id: `header_${nextLineId += 1}`,
          })),
          contextMeter: frame.contextMeter ?? null,
        },
      };
      rerender();
      emitTrace({
        kind: "shell_frame",
        title: frame.title,
        workspaceLines: frame.workspaceLines.map((line) => line.text),
        statusLines: frame.statusLines.map((line) => line.text),
        noticeLines: frame.noticeLines.map((line) => line.text),
        planLines: (frame.planLines ?? []).map((line) => line.text),
        footerLines: frame.footerLines.map((line) => line.text),
      });
    },
    renderCommands: () => {
      appendSystemLines("body", "Available commands");
      renderer.writeBodyLine("/help  Show command help");
      renderer.writeBodyLine("/provider Show or switch the active provider, model, context budget, Kimi endpoint, base URL, runtime API key, and Kimi catalog state");
      renderer.writeBodyLine("/model  Open the TTY model picker when available, or set the active model by name");
      renderer.writeBodyLine("/mode     Show or switch the active tool mode (default|strict|plan|crazy-auto)");
      renderer.writeBodyLine("/approvals Show or switch the approval mode for file edits and commands (ask|allow-all|reject)");
      renderer.writeBodyLine("/duration Show or switch the minimum command panel duration in seconds");
      renderer.writeBodyLine("/settings Show the active system prompt and persistence path");
      renderer.writeBodyLine("/session  Show current session status");
      renderer.writeBodyLine("/history  Show the current or selected session transcript and events");
      renderer.writeBodyLine("/plan     Show the current task plan or clear it with /plan reset");
      renderer.writeBodyLine("/hide    Toggle the top SuperRun header card");
      renderer.writeBodyLine("/sessions Open the saved-session picker, optionally filtered by text");
      renderer.writeBodyLine("/new [title] Create and switch to a fresh session");
      renderer.writeBodyLine("/switch   Switch to a saved session by id, title, or list index");
      renderer.writeBodyLine("/rename   Rename the current saved session");
      renderer.writeBodyLine("/delete   Delete the current session, one session by id/title/index, or all sessions");
      renderer.writeBodyLine("/trash    Open delete-area actions for viewing, restoring, deleting, or emptying files");
      renderer.writeBodyLine("/system  Edit and persist the system prompt directly in the terminal");
      renderer.writeBodyLine("/editor  Open the current system prompt in your external editor");
      renderer.writeBodyLine("/system reset Restore the built-in system prompt");
      renderer.writeBodyLine("/clear Clear the screen and redraw the header");
      renderer.writeBodyLine("/exit  Exit the session (also: exit, exit())");
      renderer.writeBodyLine("Shift+Tab Toggle plan mode on or off");
      renderer.writeBodyLine("");
    },
    renderSectionTitle: (title) => {
      appendSystemLines("body", title);
    },
    renderInfo: (message) => {
      appendSystemLines("info", message);
      emitTrace({
        kind: "info",
        message,
      });
    },
    renderError: (message) => {
      appendSystemLines("error", message);
      emitTrace({
        kind: "error",
        message,
      });
    },
    renderWarning: (message) => {
      appendSystemLines("warning", message);
      emitTrace({
        kind: "warning",
        message,
      });
    },
    writeBodyLine: (message) => {
      appendSystemLines("body", message);
      emitTrace({
        kind: "body",
        message,
      });
    },
    beginAgentTurn: (promptText) => {
      state = {
        ...state,
        turns: [
          ...state.turns,
          {
            id: `turn_${nextTurnId += 1}`,
            kind: "agent",
            status: "running_tools",
            promptText,
            steps: [],
            answerText: "",
            inlineBlock: null,
          },
        ],
      };
      rerender();
      emitTrace({
        kind: "turn_started",
        promptText,
      });
    },
    appendAssistantChunk: (chunk) => {
      emitTrace({
        kind: "assistant_chunk",
        chunk,
      });
      if (!shouldAnimateAssistantText) {
        appendAssistantTextImmediately(chunk);
        return;
      }

      pendingAssistantChunks.push(...splitAssistantChunkForAnimation(chunk));
      ensureAssistantAnimation();
    },
    completeActiveTurn: () => {
      if (shouldAnimateAssistantText && (pendingAssistantChunks.length > 0 || assistantAnimationTimer)) {
        pendingTurnStatus = "completed";
        return;
      }

      const updated = updateLatestAgentTurn((turn) => ({
        ...turn,
        status: turn.status === "failed" ? "failed" : "completed",
      }));
      if (updated) {
        rerender();
      }
      emitTrace({
        kind: "turn_completed",
      });
    },
    failActiveTurn: (message) => {
      const updated = updateLatestAgentTurn((turn) => ({
        ...turn,
        status: "failed",
        answerText: turn.answerText ? `${turn.answerText}\n\n${message}` : message,
      }));
      if (updated) {
        rerender();
        emitTrace({
          kind: "turn_failed",
          message,
        });
        return;
      }

      renderer.renderError(message);
      emitTrace({
        kind: "turn_failed",
        message,
      });
    },
    applyToolEvent: (event) => {
      emitTrace({
        kind: "tool_event",
        event,
      });
      // Batch command output events to avoid per-line rerenders.
      if (event.kind === "command_execution" && event.phase === "output") {
        pendingToolOutputEvents.push(event);
        if (!toolOutputFlushTimer) {
          toolOutputFlushTimer = setTimeout(flushPendingToolOutputEvents, 50);
        }
        return;
      }

      // Non-output events (started, completed, notice, edit review) apply
      // immediately — flush any pending output first so ordering is preserved.
      flushPendingToolOutputEvents();

      const updated = applyToolEventImmediately(event);
      if (updated) {
        rerender();
      }
    },
    clearScreen: () => {
      state = {
        ...state,
        turns: [],
        transcriptViewport: createInitialTranscriptViewport(
          state.transcriptViewport.viewportHeight,
        ),
      };
      screen.clear();
      rerender();
    },
    readPrompt: async ({ promptLabel: nextLabel, promptKind, workspaceFiles }) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      const flushPromise = waitForAssistantFlush();
      if (flushPromise) {
        await flushPromise;
      }
      options.input.resume?.();
      promptWorkspaceFiles = workspaceFiles;
      state = {
        ...state,
        inputMode: "prompt",
        overlay: null,
        prompt: {
          label: {
            kind: nextLabel === editorPromptLabel ? "editor" : "user",
            text: nextLabel,
          },
          state: syncComposerState(createComposerState(), workspaceFiles),
          kind: promptKind ?? "auxiliary",
        },
      };
      rerender();
      emitTrace({
        kind: "prompt_requested",
        label: nextLabel,
        promptKind: promptKind ?? "auxiliary",
        workspaceFileCount: workspaceFiles.length,
      });

      return new Promise<string>((resolve) => {
        promptResolver = resolve;
      });
    },
    selectOption: async (selection) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      const flushPromise = waitForAssistantFlush();
      if (flushPromise) {
        await flushPromise;
      }
      const overlayOptions = selection.options.map((option) => ({
        ...option,
        tone: option.tone ?? "default",
      }));
      const defaultIndex = overlayOptions.findIndex((option) => option.value !== null);

      state = {
        ...state,
        inputMode: "overlay",
        overlay: {
          kind: "picker",
          title: selection.title,
          subtitle: selection.subtitle ?? null,
          helpText: selection.helpText ?? null,
          emptyMessage: selection.emptyMessage ?? null,
          options: overlayOptions,
          selectedIndex: defaultIndex >= 0 ? defaultIndex : 0,
        },
      };
      rerender();
      emitTrace({
        kind: "overlay_requested",
        overlayKind: "picker",
        title: selection.title,
      });

      return new Promise<string | null>((resolve) => {
        overlayResolver = resolve;
      });
    },
    viewText: async (viewer) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      const flushPromise = waitForAssistantFlush();
      if (flushPromise) {
        await flushPromise;
      }
      state = {
        ...state,
        inputMode: "overlay",
        overlay: {
          kind: "viewer",
          title: viewer.title,
          subtitle: viewer.subtitle ?? null,
          helpText: viewer.helpText ?? "Up/Down scroll  PgUp/PgDn page  q close  Esc close",
          emptyMessage: viewer.emptyMessage ?? null,
          lines: viewer.lines,
          scrollOffset: 0,
          viewportHeight: getViewerViewportHeight(options.output),
        },
      };
      rerender();
      emitTrace({
        kind: "overlay_requested",
        overlayKind: "viewer",
        title: viewer.title,
      });

      return new Promise<void>((resolve) => {
        overlayResolver = () => resolve();
      });
    },
    requestApproval: async (approval) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      const flushPromise = waitForAssistantFlush();
      if (flushPromise) {
        await flushPromise;
      }
      const onceIndex = approval.options.findIndex((option) => option.value === "once");
      setLatestAgentInlineBlock({
        kind: "approval",
        title: approval.title,
        subtitle: approval.subtitle ?? null,
        helpText: approval.helpText ?? "Up/Down move  Enter approve once  a allow-all  Esc reject",
        options: approval.options,
        selectedIndex: onceIndex >= 0 ? onceIndex : 0,
      }, "awaiting_approval", { followLatest: true });
      state = {
        ...state,
        inputMode: "inline",
      };
      rerender();
      emitTrace({
        kind: "overlay_requested",
        overlayKind: "approval",
        title: approval.title,
      });

      return new Promise<CommandApprovalDecision>((resolve) => {
        inlineApprovalResolver = resolve;
      });
    },
    reviewDiff: async (review) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      const flushPromise = waitForAssistantFlush();
      if (flushPromise) {
        await flushPromise;
      }
      setLatestAgentInlineBlock({
        kind: "diff",
        mode: "approval",
        title: review.title,
        subtitle: review.subtitle ?? null,
        helpText: review.helpText ?? "Up/Down scroll  PgUp/PgDn page  Enter approve once  a allow-all  Esc reject",
        summary: review.summary,
        changeSummary: review.changeSummary,
        truncated: review.truncated ?? false,
        lines: review.lines,
        scrollOffset: 0,
        viewportHeight: getDiffViewportHeight(options.output),
      }, "awaiting_approval", { followLatest: true });
      state = {
        ...state,
        inputMode: "inline",
      };
      rerender();
      emitTrace({
        kind: "overlay_requested",
        overlayKind: "diff_approval",
        title: review.title,
      });

      return new Promise<CommandApprovalDecision>((resolve) => {
        diffResolver = resolve;
      });
    },
    viewDiff: async (review) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      const flushPromise = waitForAssistantFlush();
      if (flushPromise) {
        await flushPromise;
      }
      setLatestAgentInlineBlock({
        kind: "diff",
        mode: "review",
        title: review.title,
        subtitle: review.subtitle ?? null,
        helpText: review.helpText ?? "Up/Down scroll  PgUp/PgDn page  Enter close  Esc close",
        summary: review.summary,
        changeSummary: review.changeSummary,
        truncated: review.truncated ?? false,
        lines: review.lines,
        scrollOffset: 0,
        viewportHeight: getDiffViewportHeight(options.output),
      }, getLatestAgentTurn()?.status === "failed" ? "failed" : "completed", {
        followLatest: true,
      });
      state = {
        ...state,
        inputMode: "inline",
      };
      rerender();
      emitTrace({
        kind: "overlay_requested",
        overlayKind: "diff_review",
        title: review.title,
      });

      return new Promise<void>((resolve) => {
        diffReviewResolver = resolve;
      });
    },
    getSnapshot: () => ({
      shellFrame: cloneRendererShellFrame(state.shellFrame),
      turns: state.turns.map(cloneRendererTurn),
      prompt: {
        label: { ...state.prompt.label },
        state: { ...state.prompt.state },
        kind: state.prompt.kind,
      },
      inputMode: state.inputMode,
      inputActive: state.inputMode !== "inactive",
      overlay: cloneRendererOverlay(state.overlay),
      transcriptViewport: cloneRendererTranscriptViewport(state.transcriptViewport),
      statusText: buildStatusText(state),
    }),
    dispatchInput: (inputValue, key) => {
      handleInput(inputValue, key);
    },
    suspend: () => {
      if (!mounted) {
        return;
      }

      mounted = false;
      detachInput();
      options.output.off?.("resize", handleResize);
      screen.suspend();
    },
    resume: () => {
      screen.resume();
      mount();
    },
    dispose: () => {
      for (const timer of pendingCommandCompletionTimers.values()) {
        clearTimeout(timer);
      }
      pendingCommandCompletionTimers.clear();
      if (assistantAnimationTimer) {
        clearTimeout(assistantAnimationTimer);
        assistantAnimationTimer = null;
      }
      if (toolOutputFlushTimer) {
        clearTimeout(toolOutputFlushTimer);
        toolOutputFlushTimer = null;
      }
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
      detachInput();
      options.input.pause?.();
      options.output.off?.("resize", handleResize);
      mounted = false;
      screen.dispose();
    },
  };

  const handleResize = () => {
    screen.clear();
    rerender();
  };

  const handleTerminalKeypress = (inputValue: string, key: ReadlineKey | undefined) => {
    handleInput(inputValue, mapReadlineKeyToInkKey(key));
  };

  const attachInput = () => {
    if (!inputEnabled || inputAttached) {
      return;
    }

    if (!keypressEventsInitialized) {
      emitKeypressEvents(options.input);
      keypressEventsInitialized = true;
    }

    const keypressInput = options.input as NodeJS.ReadStream & {
      on: (event: "keypress", listener: typeof handleTerminalKeypress) => void;
      off: (event: "keypress", listener: typeof handleTerminalKeypress) => void;
    };
    keypressInput.on("keypress", handleTerminalKeypress);
    if (options.input.isTTY) {
      options.input.setRawMode?.(true);
    }
    inputAttached = true;
  };

  const detachInput = () => {
    if (!inputAttached) {
      return;
    }

    const keypressInput = options.input as NodeJS.ReadStream & {
      on: (event: "keypress", listener: typeof handleTerminalKeypress) => void;
      off: (event: "keypress", listener: typeof handleTerminalKeypress) => void;
    };
    keypressInput.off("keypress", handleTerminalKeypress);
    if (options.input.isTTY) {
      options.input.setRawMode?.(false);
    }
    inputAttached = false;
  };

  const syncSpinnerTimer = () => {
    const hasActiveSpinner = state.turns.some((turn) =>
      turn.kind === "agent" && (
        turn.status === "running_tools" ||
        turn.status === "streaming_answer" ||
        turn.steps.some((step) => step.kind === "command" && step.status === "running")
      )
    );

    if (!hasActiveSpinner) {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
      spinnerTick = 0;
      return;
    }

    if (spinnerTimer) {
      return;
    }

    spinnerTimer = setInterval(() => {
      spinnerTick += 1;
      rerender();
    }, 80);
  };

  const handleInput = (inputValue: string, key: Parameters<typeof normalizeInkInput>[1]) => {
    const event = normalizeInkInput(inputValue, key, {
      platform: process.platform,
      promptBufferLength: state.prompt.state.buffer.length,
      promptCursorIndex: state.prompt.state.cursorIndex,
    });
    if (!event) {
      return;
    }

    if (
      event.type === "toggle_plan_mode" &&
      (
        state.inputMode === "inactive" ||
        (state.inputMode === "prompt" && state.prompt.kind === "primary")
      )
    ) {
      options.onShortcut?.("toggle_plan_mode");
      return;
    }

    if (
      state.inputMode === "inactive" &&
      event.type === "interrupt" &&
      state.canInterruptActiveRequest
    ) {
      interruptActiveRequest();
      return;
    }

    if (
      state.inputMode === "inactive" &&
      event.type === "cancel" &&
      state.canCancelActiveRequest
    ) {
      cancelActiveRequest();
      return;
    }

    if (state.inputMode === "overlay" && state.overlay) {
      handleOverlayInput(event);
      return;
    }

    if (state.inputMode === "inline") {
      handleInlineInput(event);
      return;
    }

    if (state.inputMode === "inactive") {
      handleTranscriptInput(event);
      return;
    }

    if (state.inputMode !== "prompt" || !promptResolver) {
      return;
    }

    handlePromptInput(event);
  };

  const handleOverlayInput = (event: ReturnType<typeof normalizeInkInput>) => {
    if (!event || !state.overlay || !overlayResolver) {
      return;
    }

    if (state.overlay.kind === "viewer") {
      if (
        event.type === "interrupt" ||
        event.type === "cancel" ||
        event.type === "submit" ||
        (event.type === "insert_text" && event.text.trim().toLowerCase() === "q")
      ) {
        resolveOverlay(null);
        return;
      }

      switch (event.type) {
        case "move_up":
          state = {
            ...state,
            overlay: moveViewerScroll(state.overlay, -1),
          };
          rerender();
          return;
        case "move_down":
          state = {
            ...state,
            overlay: moveViewerScroll(state.overlay, 1),
          };
          rerender();
          return;
        case "move_page_up":
          state = {
            ...state,
            overlay: moveViewerScroll(state.overlay, -state.overlay.viewportHeight),
          };
          rerender();
          return;
        case "move_page_down":
          state = {
            ...state,
            overlay: moveViewerScroll(state.overlay, state.overlay.viewportHeight),
          };
          rerender();
          return;
        case "move_home":
          state = {
            ...state,
            overlay: {
              ...state.overlay,
              scrollOffset: 0,
            },
          };
          rerender();
          return;
        case "move_end":
          state = {
            ...state,
            overlay: {
              ...state.overlay,
              scrollOffset: Math.max(0, state.overlay.lines.length - state.overlay.viewportHeight),
            },
          };
          rerender();
          return;
        default:
          return;
      }
    }

    if (event.type === "interrupt" || event.type === "cancel") {
      resolveOverlay(null);
      return;
    }

    if (event.type === "submit") {
      const selectedOption = state.overlay.options[state.overlay.selectedIndex] ?? null;
      resolveOverlay(selectedOption?.value ?? null);
      return;
    }

    if (event.type === "move_up") {
      state = {
        ...state,
        overlay: moveOverlaySelection(state.overlay, -1),
      };
      rerender();
      return;
    }

    if (event.type === "move_down") {
      state = {
        ...state,
        overlay: moveOverlaySelection(state.overlay, 1),
      };
      rerender();
      return;
    }

    if (event.type === "move_home") {
      state = {
        ...state,
        overlay: {
          ...state.overlay,
          selectedIndex: 0,
        },
      };
      rerender();
      return;
    }

    if (event.type === "move_end") {
      state = {
        ...state,
        overlay: {
          ...state.overlay,
          selectedIndex: Math.max(0, state.overlay.options.length - 1),
        },
      };
      rerender();
    }
  };

  const handleInlineInput = (event: ReturnType<typeof normalizeInkInput>) => {
    const latestTurn = getLatestAgentTurn();
    const inlineBlock = latestTurn?.inlineBlock;
    if (!event || !latestTurn || !inlineBlock) {
      return;
    }

    if (inlineBlock.kind === "approval") {
      if (!inlineApprovalResolver) {
        return;
      }

      if (event.type === "interrupt" || event.type === "cancel") {
        resolveInlineApproval("reject");
        return;
      }

      if (event.type === "submit") {
        const selectedOption = inlineBlock.options[inlineBlock.selectedIndex];
        resolveInlineApproval(selectedOption?.value ?? "reject");
        return;
      }

      if (event.type === "insert_text") {
        const normalizedText = event.text.trim().toLowerCase();
        if (normalizedText === "a") {
          resolveInlineApproval("always");
          return;
        }

        if (normalizedText === "r") {
          resolveInlineApproval("reject");
          return;
        }
      }

      if (event.type === "move_up" || event.type === "move_down" || event.type === "move_home" || event.type === "move_end") {
        setLatestAgentInlineBlock(moveApprovalSelection(inlineBlock, event.type));
      }
      return;
    }

    if (inlineBlock.mode === "review") {
      if (event.type === "interrupt" || event.type === "cancel" || event.type === "submit") {
        resolveDiffReview();
        return;
      }
    } else if (!diffResolver) {
      return;
    }

    if (inlineBlock.mode === "approval" && (event.type === "interrupt" || event.type === "cancel")) {
      resolveDiffApproval("reject");
      return;
    }

    if (inlineBlock.mode === "approval" && event.type === "submit") {
      resolveDiffApproval("once");
      return;
    }

    if (inlineBlock.mode === "approval" && event.type === "insert_text") {
      const normalizedText = event.text.trim().toLowerCase();
      if (normalizedText === "a") {
        resolveDiffApproval("always");
        return;
      }

      if (normalizedText === "r") {
        resolveDiffApproval("reject");
        return;
      }
    }

    switch (event.type) {
      case "move_up":
        setLatestAgentInlineBlock(moveDiffScroll(inlineBlock, -1));
        return;
      case "move_down":
        setLatestAgentInlineBlock(moveDiffScroll(inlineBlock, 1));
        return;
      case "move_page_up":
        setLatestAgentInlineBlock(moveDiffScroll(inlineBlock, -inlineBlock.viewportHeight));
        return;
      case "move_page_down":
        setLatestAgentInlineBlock(moveDiffScroll(inlineBlock, inlineBlock.viewportHeight));
        return;
      case "move_home":
        setLatestAgentInlineBlock({
          ...inlineBlock,
          scrollOffset: 0,
        });
        return;
      case "move_end":
        setLatestAgentInlineBlock({
          ...inlineBlock,
          scrollOffset: Math.max(0, inlineBlock.lines.length - inlineBlock.viewportHeight),
        });
        return;
      default:
        return;
    }
  };

  const handlePromptInput = (event: ReturnType<typeof normalizeInkInput>) => {
    if (!event) {
      return;
    }

    let nextComposerState = state.prompt.state;

    if (event.type === "interrupt") {
      resolvePrompt("/exit");
      return;
    }

    if (event.type === "submit") {
      const submission = submitComposer(nextComposerState, promptWorkspaceFiles);
      nextComposerState = submission.state;
      state = {
        ...state,
        prompt: {
          ...state.prompt,
          state: nextComposerState,
        },
      };
      rerender();

      if (submission.submittedText !== null) {
        resolvePrompt(submission.submittedText);
      }
      return;
    }

    if (event.type === "move_page_up") {
      moveTranscriptViewport(-state.transcriptViewport.viewportHeight);
      return;
    }

    if (event.type === "move_page_down") {
      moveTranscriptViewport(state.transcriptViewport.viewportHeight);
      return;
    }

    switch (event.type) {
      case "backspace":
        nextComposerState = backspaceComposerText(nextComposerState, promptWorkspaceFiles);
        break;
      case "delete":
        nextComposerState = deleteComposerText(nextComposerState, promptWorkspaceFiles);
        break;
      case "move_left":
        nextComposerState = moveComposerCursor(
          nextComposerState,
          nextComposerState.cursorIndex - 1,
          promptWorkspaceFiles,
        );
        break;
      case "move_right":
        nextComposerState = moveComposerCursor(
          nextComposerState,
          nextComposerState.cursorIndex + 1,
          promptWorkspaceFiles,
        );
        break;
      case "move_home":
        jumpTranscriptViewportToTop();
        return;
      case "move_end":
        if (!state.transcriptViewport.followLatest) {
          followTranscriptViewportLatest();
          return;
        }
        nextComposerState = moveComposerCursor(
          nextComposerState,
          nextComposerState.buffer.length,
          promptWorkspaceFiles,
        );
        break;
      case "move_up":
        if (nextComposerState.suggestions.length > 0) {
          nextComposerState = moveComposerSuggestionSelection(nextComposerState, "up", promptWorkspaceFiles);
        } else {
          moveTranscriptViewport(-1);
          return;
        }
        break;
      case "move_down":
        if (nextComposerState.suggestions.length > 0) {
          nextComposerState = moveComposerSuggestionSelection(nextComposerState, "down", promptWorkspaceFiles);
        } else {
          moveTranscriptViewport(1);
          return;
        }
        break;
      case "cancel":
        if (nextComposerState.errorMessage) {
          nextComposerState = clearComposerError(nextComposerState, promptWorkspaceFiles);
          break;
        }

        if (!state.transcriptViewport.followLatest) {
          followTranscriptViewportLatest();
        }
        return;
      case "apply_suggestion":
        nextComposerState = applySelectedComposerSuggestion(nextComposerState, promptWorkspaceFiles);
        break;
      case "insert_text":
        nextComposerState = insertComposerText(nextComposerState, event.text, promptWorkspaceFiles);
        break;
      default:
        return;
    }

    state = {
      ...state,
      prompt: {
        ...state.prompt,
        state: nextComposerState,
      },
    };
    rerender();
  };

  mount();
  return renderer;

  function handleTranscriptInput(event: ReturnType<typeof normalizeInkInput>) {
    if (!event) {
      return;
    }

    switch (event.type) {
      case "move_up":
        moveTranscriptViewport(-1);
        return;
      case "move_down":
        moveTranscriptViewport(1);
        return;
      case "move_page_up":
        moveTranscriptViewport(-state.transcriptViewport.viewportHeight);
        return;
      case "move_page_down":
        moveTranscriptViewport(state.transcriptViewport.viewportHeight);
        return;
      case "move_home":
        jumpTranscriptViewportToTop();
        return;
      case "move_end":
      case "cancel":
        followTranscriptViewportLatest();
        return;
      default:
        return;
    }
  }

  function moveTranscriptViewport(delta: number) {
    const current = state.transcriptViewport;
    const currentOffset = current.followLatest
      ? current.maxScrollOffsetLines
      : current.scrollOffsetLines;
    const nextOffset = clamp(currentOffset + delta, 0, current.maxScrollOffsetLines);

    if (current.followLatest && nextOffset === current.maxScrollOffsetLines) {
      return;
    }

    const nextViewport: RendererTranscriptViewport = {
      ...current,
      followLatest: false,
      scrollOffsetLines: nextOffset,
      pendingBelowLines: delta > 0
        ? Math.max(0, current.pendingBelowLines - (nextOffset - currentOffset))
        : current.pendingBelowLines,
    };

    if (rendererTranscriptViewportEquals(current, nextViewport)) {
      return;
    }

    state = {
      ...state,
      transcriptViewport: nextViewport,
    };
    rerender();
  }

  function jumpTranscriptViewportToTop() {
    const current = state.transcriptViewport;
    const nextViewport: RendererTranscriptViewport = {
      ...current,
      followLatest: false,
      scrollOffsetLines: 0,
    };

    if (rendererTranscriptViewportEquals(current, nextViewport)) {
      return;
    }

    state = {
      ...state,
      transcriptViewport: nextViewport,
    };
    rerender();
  }

  function followTranscriptViewportLatest() {
    const current = state.transcriptViewport;
    const nextViewport: RendererTranscriptViewport = {
      ...current,
      followLatest: true,
      scrollOffsetLines: current.maxScrollOffsetLines,
      pendingBelowLines: 0,
      hiddenBelowLines: 0,
    };

    if (rendererTranscriptViewportEquals(current, nextViewport)) {
      return;
    }

    state = {
      ...state,
      transcriptViewport: nextViewport,
    };
    rerender();
  }
}

function applyToolEventToTurn(
  turn: RendererAgentTurn,
  event: ToolTurnEvent,
  options?: {
    minCommandPanelDurationMs: number;
    scheduleCommandCompletion: (
      stepId: string,
      event: Extract<ToolTurnEvent, { kind: "command_execution"; phase: "completed" }>,
      remainingMs: number,
    ) => void;
  },
): RendererAgentTurn {
  if (event.kind === "notice") {
    return {
      ...turn,
      steps: [
        ...turn.steps,
        {
          id: `notice_${turn.steps.length + 1}`,
          kind: "notice",
          title: event.level.toUpperCase(),
          summary: event.message,
          status: event.level === "error" ? "failed" : "completed",
          command: null,
          cwd: null,
          category: null,
          path: null,
          outputLines: [],
          outputRemainder: "",
          outputTruncated: false,
          exitCode: null,
          timedOut: false,
          stream: null,
          startedAtMs: null,
        },
      ],
    };
  }

  if (event.kind === "workspace_edit_review") {
    return {
      ...turn,
      steps: [
        ...turn.steps,
        {
          id: `edit_${turn.steps.length + 1}`,
          kind: "workspace_edit",
          title: `${event.tool} ${event.path}`,
          summary: `${event.summary} (${formatChangeSummary(event.diffPreview.changeSummary)})`,
          status: "completed",
          command: null,
          cwd: null,
          category: null,
          path: event.path,
          outputLines: [],
          outputRemainder: "",
          outputTruncated: false,
          exitCode: null,
          timedOut: false,
          stream: null,
          startedAtMs: null,
        },
      ],
    };
  }

  if (event.phase === "started") {
    return {
      ...turn,
      status: "running_tools",
      steps: [
        ...turn.steps,
        {
          id: `command_${turn.steps.length + 1}`,
          kind: "command",
          title: event.command,
          summary: event.summary,
          status: "running",
          command: event.command,
          cwd: event.cwd,
          category: event.category,
          path: null,
          outputLines: [],
          outputRemainder: "",
          outputTruncated: false,
          exitCode: null,
          timedOut: false,
          stream: null,
          startedAtMs: Date.now(),
        },
      ],
    };
  }

  const activeCommandIndex = [...turn.steps].findLastIndex((step) =>
    step.kind === "command" &&
    step.command === event.command &&
    step.cwd === event.cwd
  );
  if (activeCommandIndex === -1) {
    return turn;
  }

  const nextSteps = [...turn.steps];
  const targetStep = nextSteps[activeCommandIndex];
  if (!targetStep || targetStep.kind !== "command") {
    return turn;
  }

  if (event.phase === "output") {
    nextSteps[activeCommandIndex] = appendCommandOutput(targetStep, event.chunk, event.stream);
    return {
      ...turn,
      steps: nextSteps,
    };
  }

  const elapsedMs =
    targetStep.startedAtMs === null
      ? options?.minCommandPanelDurationMs ?? 0
      : Date.now() - targetStep.startedAtMs;
  const remainingMs = (options?.minCommandPanelDurationMs ?? 0) - elapsedMs;

  if (remainingMs > 0) {
    options?.scheduleCommandCompletion(targetStep.id, event, remainingMs);
    return turn;
  }

  nextSteps[activeCommandIndex] = finalizeCommandStep(targetStep, event);
  return {
    ...turn,
    steps: nextSteps,
  };
}

function appendCommandOutput(
  step: RendererToolStep,
  chunk: string,
  stream: "stdout" | "stderr",
): RendererToolStep {
  const combined = `${step.outputRemainder}${chunk}`;
  const normalized = combined.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let remainder = lines.pop() ?? "";
  if (normalized.endsWith("\n")) {
    remainder = "";
  }
  const truncatedOutput = truncateOutputLines([
    ...step.outputLines,
    ...lines.map((line) => `${stream === "stderr" ? "stderr" : "stdout"} | ${line}`),
  ]);

  return {
    ...step,
    outputLines: truncatedOutput.lines,
    outputRemainder: remainder,
    outputTruncated: step.outputTruncated || truncatedOutput.truncated,
    stream,
  };
}

function finalizeCommandStep(
  step: RendererToolStep,
  event: Extract<ToolTurnEvent, { kind: "command_execution"; phase: "completed" }>,
): RendererToolStep {
  let outputLines = step.outputLines;
  if (step.outputRemainder) {
    const truncatedOutput = truncateOutputLines([
      ...outputLines,
      `${step.stream === "stderr" ? "stderr" : "stdout"} | ${step.outputRemainder}`,
    ]);
    outputLines = truncatedOutput.lines;
  }

  return {
    ...step,
    summary: event.timedOut
      ? "Timed out"
      : event.exitCode === 0
        ? event.summary
        : `Exited with code ${event.exitCode ?? "null"}`,
    status: event.timedOut
      ? "timed_out"
      : event.exitCode === 0
        ? "completed"
        : "failed",
    outputLines,
    outputRemainder: "",
    outputTruncated: step.outputTruncated || event.truncated,
    exitCode: event.exitCode,
    timedOut: event.timedOut,
    startedAtMs: step.startedAtMs,
  };
}

function truncateOutputLines(lines: string[]): { lines: string[]; truncated: boolean } {
  if (lines.length <= MAX_COMMAND_OUTPUT_LINES) {
    return { lines, truncated: false };
  }

  return {
    lines: lines.slice(lines.length - MAX_COMMAND_OUTPUT_LINES),
    truncated: true,
  };
}

function splitAssistantChunkForAnimation(chunk: string): string[] {
  if (chunk.length <= ASSISTANT_ANIMATION_CHUNK_SIZE) {
    return [chunk];
  }

  const segments: string[] = [];
  let current = "";

  for (const character of chunk) {
    if (character === "\n") {
      if (current) {
        segments.push(current);
        current = "";
      }
      segments.push(character);
      continue;
    }

    current += character;
    if (current.length >= ASSISTANT_ANIMATION_CHUNK_SIZE) {
      segments.push(current);
      current = "";
    }
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

function normalizeMinimumCommandPanelDurationMs(
  value: number | undefined,
): number {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_MIN_COMMAND_PANEL_DURATION_MS;
  }

  return Math.max(0, Math.round(value));
}

function cloneRendererLine(line: RendererLine): RendererLine {
  return { ...line };
}

function cloneRendererShellFrame(frame: RendererShellFrame): RendererShellFrame {
  return {
    title: frame.title,
    workspaceLines: frame.workspaceLines.map(cloneRendererLine),
    statusLines: frame.statusLines.map(cloneRendererLine),
    noticeLines: frame.noticeLines.map(cloneRendererLine),
    planLines: (frame.planLines ?? []).map(cloneRendererLine),
    footerLines: frame.footerLines.map(cloneRendererLine),
    contextMeter: frame.contextMeter ? { ...frame.contextMeter } : null,
  };
}

function cloneRendererTurn(turn: RendererTurnCard): RendererTurnCard {
  if (turn.kind === "system") {
    return {
      ...turn,
      lines: turn.lines.map(cloneRendererLine),
    };
  }

  return {
    ...turn,
    steps: turn.steps.map((step) => ({
      ...step,
      outputLines: [...step.outputLines],
    })),
    inlineBlock: turn.inlineBlock
      ? turn.inlineBlock.kind === "approval"
        ? {
            ...turn.inlineBlock,
            options: [...turn.inlineBlock.options],
          }
        : {
            ...turn.inlineBlock,
            lines: [...turn.inlineBlock.lines],
          }
      : null,
  };
}

function cloneRendererOverlay(
  overlay: RendererOverlay | null,
): RendererOverlay | null {
  if (!overlay) {
    return null;
  }

  if (overlay.kind === "picker") {
    return {
      ...overlay,
      options: [...overlay.options],
    };
  }

  return {
    ...overlay,
    lines: [...overlay.lines],
  };
}

function cloneRendererTranscriptViewport(
  viewport: RendererTranscriptViewport,
): RendererTranscriptViewport {
  return { ...viewport };
}

function moveOverlaySelection(
  overlay: RendererPickerOverlay,
  delta: number,
): RendererPickerOverlay {
  if (overlay.options.length === 0) {
    return overlay;
  }

  return {
    ...overlay,
    selectedIndex: (overlay.selectedIndex + delta + overlay.options.length) % overlay.options.length,
  };
}

function moveViewerScroll(
  overlay: RendererViewerOverlay,
  delta: number,
): RendererViewerOverlay {
  const maxOffset = Math.max(0, overlay.lines.length - overlay.viewportHeight);
  return {
    ...overlay,
    scrollOffset: Math.min(Math.max(overlay.scrollOffset + delta, 0), maxOffset),
  };
}

function moveApprovalSelection(
  block: RendererInlineApprovalBlock,
  action: "move_up" | "move_down" | "move_home" | "move_end",
): RendererInlineApprovalBlock {
  if (block.options.length === 0) {
    return block;
  }

  if (action === "move_home") {
    return { ...block, selectedIndex: 0 };
  }

  if (action === "move_end") {
    return { ...block, selectedIndex: Math.max(0, block.options.length - 1) };
  }

  const delta = action === "move_up" ? -1 : 1;
  return {
    ...block,
    selectedIndex: (block.selectedIndex + delta + block.options.length) % block.options.length,
  };
}

function moveDiffScroll(
  block: RendererDiffBlock,
  delta: number,
): RendererDiffBlock {
  const maxOffset = Math.max(0, block.lines.length - block.viewportHeight);
  return {
    ...block,
    scrollOffset: Math.min(Math.max(block.scrollOffset + delta, 0), maxOffset),
  };
}

function buildStatusText(state: RendererState): string {
  if (state.inputMode === "overlay") {
    if (state.overlay?.kind === "viewer") {
      return state.overlay.helpText ?? "Up/Down scroll  PgUp/PgDn page  q close  Esc close";
    }

    return state.overlay?.helpText ?? "Up/Down move  Enter select  Esc cancel";
  }

  if (state.inputMode === "inline") {
    const latestTurn = [...state.turns].reverse().find((turn) => turn.kind === "agent");
    if (latestTurn?.kind === "agent") {
      if (latestTurn.inlineBlock?.kind === "approval") {
        return latestTurn.inlineBlock.helpText ?? "Up/Down move  Enter approve once  a allow-all  Esc reject";
      }

      if (latestTurn.inlineBlock?.kind === "diff") {
        return latestTurn.inlineBlock.helpText ?? (
          latestTurn.inlineBlock.mode === "approval"
            ? "Up/Down scroll  PgUp/PgDn page  Enter approve once  a allow-all  Esc reject"
            : "Up/Down scroll  PgUp/PgDn page  Enter close  Esc close"
        );
      }
    }
  }

  if (state.inputMode === "prompt" && state.prompt.state.activeReference) {
    return state.prompt.kind === "primary"
      ? "Tab insert file  Up/Down choose  Enter submit  Shift+Tab plan  Esc clear"
      : "Tab insert file  Up/Down choose  Enter submit  Esc clear";
  }

  if (
    state.inputMode === "prompt" &&
    state.prompt.state.activeSlashCommand &&
    state.prompt.state.suggestions.length > 0
  ) {
    return state.prompt.kind === "primary"
      ? "Enter accept command  Tab accept  Up/Down choose  Shift+Tab plan  Esc clear"
      : "Enter accept command  Tab accept  Up/Down choose  Esc clear";
  }

  if (!state.transcriptViewport.followLatest) {
    const pendingText = state.transcriptViewport.pendingBelowLines > 0
      ? `  ${state.transcriptViewport.pendingBelowLines} new below`
      : "";
    const cancelText = state.canCancelActiveRequest ? "  Esc cancel request" : "";
    const interruptText = state.canInterruptActiveRequest ? "  Ctrl+C exit" : "";
    return `Browsing transcript  ${state.transcriptViewport.hiddenBelowLines} lines from latest  PgUp/PgDn scroll  End/Esc follow latest${pendingText}${cancelText}${interruptText}`;
  }

  if (state.inputMode === "prompt") {
    return state.prompt.kind === "primary"
      ? "Enter submit  Shift+Tab plan  Ctrl+C exit"
      : "Enter submit  Ctrl+C exit";
  }

  if (state.canCancelActiveRequest || state.canInterruptActiveRequest) {
    const actions = [
      state.canCancelActiveRequest ? "Esc cancel request" : null,
      state.canInterruptActiveRequest ? "Ctrl+C exit" : null,
    ].filter(Boolean).join("  ");
    return `Agent is working  ${actions}`;
  }

  return "Agent is working";
}

function buildDivider(output: Writable): string {
  const columns =
    "columns" in output && typeof output.columns === "number"
      ? output.columns
      : 80;
  const width = Math.min(Math.max(columns, 40), 120);
  return "─".repeat(width);
}

function getDiffViewportHeight(output: Writable): number {
  const rows =
    "rows" in output && typeof output.rows === "number"
      ? output.rows
      : 24;

  return Math.min(Math.max(rows - 16, 8), 14);
}

function getViewerViewportHeight(output: Writable): number {
  const rows =
    "rows" in output && typeof output.rows === "number"
      ? output.rows
      : 24;

  return Math.min(Math.max(rows - 10, 10), 18);
}

function getCommandViewportHeight(output: Writable): number {
  const rows =
    "rows" in output && typeof output.rows === "number"
      ? output.rows
      : 24;

  return Math.min(Math.max(rows - 14, 8), 14);
}

function formatChangeSummary(summary: WorkspaceEditChangeSummary): string {
  return `changed ${summary.changedLines}, added ${summary.addedLines}, removed ${summary.removedLines}`;
}

function getShellHeight(output: Writable): number {
  const rows =
    "rows" in output && typeof output.rows === "number"
      ? output.rows
      : 24;

  return Math.max(12, rows);
}

function getTranscriptViewportFallbackHeight(output: Writable): number {
  return Math.max(4, getShellHeight(output) - 10);
}

function createInitialTranscriptViewport(
  viewportHeight: number,
): RendererTranscriptViewport {
  return {
    followLatest: true,
    scrollOffsetLines: 0,
    pendingBelowLines: 0,
    totalLines: 0,
    viewportHeight: Math.max(1, viewportHeight),
    maxScrollOffsetLines: 0,
    hiddenAboveLines: 0,
    hiddenBelowLines: 0,
  };
}

function rendererTranscriptViewportEquals(
  left: RendererTranscriptViewport,
  right: RendererTranscriptViewport,
): boolean {
  return (
    left.followLatest === right.followLatest &&
    left.scrollOffsetLines === right.scrollOffsetLines &&
    left.pendingBelowLines === right.pendingBelowLines &&
    left.totalLines === right.totalLines &&
    left.viewportHeight === right.viewportHeight &&
    left.maxScrollOffsetLines === right.maxScrollOffsetLines &&
    left.hiddenAboveLines === right.hiddenAboveLines &&
    left.hiddenBelowLines === right.hiddenBelowLines
  );
}

function reconcileTranscriptViewport(
  current: RendererTranscriptViewport,
  metrics: Pick<
    RendererTranscriptViewport,
    | "totalLines"
    | "viewportHeight"
    | "maxScrollOffsetLines"
    | "hiddenAboveLines"
    | "hiddenBelowLines"
    | "scrollOffsetLines"
  >,
): RendererTranscriptViewport {
  const lineDelta = Math.max(0, metrics.totalLines - current.totalLines);

  return {
    ...current,
    totalLines: metrics.totalLines,
    viewportHeight: metrics.viewportHeight,
    maxScrollOffsetLines: metrics.maxScrollOffsetLines,
    hiddenAboveLines: metrics.hiddenAboveLines,
    hiddenBelowLines: metrics.hiddenBelowLines,
    scrollOffsetLines: current.followLatest
      ? metrics.maxScrollOffsetLines
      : clamp(current.scrollOffsetLines, 0, metrics.maxScrollOffsetLines),
    pendingBelowLines: current.followLatest
      ? 0
      : Math.min(current.pendingBelowLines + lineDelta, metrics.hiddenBelowLines),
  };
}

function mapReadlineKeyToInkKey(key: ReadlineKey | undefined): Key {
  return {
    upArrow: key?.name === "up",
    downArrow: key?.name === "down",
    leftArrow: key?.name === "left",
    rightArrow: key?.name === "right",
    pageDown: key?.name === "pagedown",
    pageUp: key?.name === "pageup",
    home: key?.name === "home",
    end: key?.name === "end",
    return: key?.name === "return" || key?.name === "enter",
    escape: key?.name === "escape",
    ctrl: key?.ctrl ?? false,
    shift: key?.shift ?? false,
    tab: key?.name === "tab",
    backspace: key?.name === "backspace",
    delete: key?.name === "delete",
    meta: key?.meta ?? false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
