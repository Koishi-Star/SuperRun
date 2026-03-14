import type { Writable } from "node:stream";
import { render, type Instance } from "ink";
import React from "react";
import type {
  CommandApprovalDecision,
  CommandCategory,
  ToolTurnEvent,
  WorkspaceEditChangeSummary,
  WorkspaceEditDiffPreviewLine,
} from "../tools/types.js";
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
import { InteractiveShell } from "./ink/interactive-shell.js";
import { normalizeInkInput } from "./input-events.js";

export type RendererLine = {
  id: string;
  kind: "info" | "error" | "warning" | "section" | "body";
  text: string;
};

export type RendererPrompt = {
  label: {
    kind: "user" | "editor";
    text: string;
  };
  state: ComposerState;
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

export type RendererPickerOverlay = {
  kind: "picker";
  title: string;
  subtitle: string | null;
  helpText: string | null;
  emptyMessage: string | null;
  options: RendererOverlayOption[];
  selectedIndex: number;
};

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

export type InteractiveRenderer = {
  promptLabel: string;
  editorPromptLabel: string;
  setShellFrame: (lines: Array<Omit<RendererLine, "id">>) => void;
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
    workspaceFiles: string[];
  }) => Promise<string>;
  selectOption: (options: RendererSelectOptions) => Promise<string | null>;
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
  headerLines: RendererLine[];
  turns: RendererTurnCard[];
  prompt: RendererPrompt;
  inputMode: RendererInputMode;
  overlay: RendererPickerOverlay | null;
};

export type InteractiveRendererSnapshot = {
  headerLines: RendererLine[];
  turns: RendererTurnCard[];
  prompt: RendererPrompt;
  inputMode: RendererInputMode;
  inputActive: boolean;
  overlay: RendererPickerOverlay | null;
  statusText: string;
};

const MAX_COMMAND_OUTPUT_LINES = 200;

export function createInteractiveRenderer(options: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  enableInput?: boolean;
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
  let instance: Instance | null = null;
  let state: RendererState = {
    headerLines: [],
    turns: [],
    prompt: {
      label: {
        kind: "user",
        text: promptLabel,
      },
      state: createComposerState(),
    },
    inputMode: "inactive",
    overlay: null,
  };

  const mount = () => {
    const node = renderApp();
    if (instance) {
      instance.rerender(node);
      return;
    }

    instance = render(node, {
      stdin: options.input,
      stdout: options.output,
      stderr: process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 60,
    });
  };

  const rerender = () => {
    if (!instance) {
      return;
    }

    instance.rerender(renderApp());
  };

  const renderApp = () => (
    <InteractiveShell
      headerLines={state.headerLines}
      turns={state.turns}
      prompt={state.prompt}
      divider={buildDivider(options.output)}
      inputEnabled={options.enableInput ?? true}
      inputMode={state.inputMode}
      overlay={state.overlay}
      statusText={buildStatusText(state)}
      commandViewportHeight={getCommandViewportHeight(options.output)}
      onInput={handleInput}
    />
  );

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

  const setLatestAgentInlineBlock = (
    block: RendererInlineBlock | null,
    status?: RendererAgentTurn["status"],
  ) => {
    const updated = updateLatestAgentTurn((turn) => ({
      ...turn,
      ...(status ? { status } : {}),
      inlineBlock: block,
    }));
    if (updated) {
      rerender();
    }
  };

  const resolvePrompt = (value: string) => {
    const resolver = promptResolver;
    promptResolver = null;
    state = {
      ...state,
      inputMode: "inactive",
    };
    rerender();
    resolver?.(value);
  };

  const resolveOverlay = (value: string | null) => {
    const resolver = overlayResolver;
    overlayResolver = null;
    state = {
      ...state,
      inputMode: "inactive",
      overlay: null,
    };
    rerender();
    resolver?.(value);
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
    resolver?.();
  };

  const renderer: InteractiveRenderer = {
    promptLabel,
    editorPromptLabel,
    setShellFrame: (lines) => {
      state = {
        ...state,
        headerLines: lines.map((line) => ({
          ...line,
          id: `header_${nextLineId += 1}`,
        })),
      };
      rerender();
    },
    renderCommands: () => {
      renderer.renderSectionTitle("Available commands");
      renderer.writeBodyLine("/help  Show command help");
      renderer.writeBodyLine("/mode     Show or switch the active tool mode (default|strict)");
      renderer.writeBodyLine("/approvals Show or switch the approval mode for file edits and commands (ask|allow-all|crazy_auto|reject)");
      renderer.writeBodyLine("/settings Show the active system prompt and persistence path");
      renderer.writeBodyLine("/session  Show current session status");
      renderer.writeBodyLine("/history  Show the current or selected session transcript and events");
      renderer.writeBodyLine("/sessions Open the saved-session picker, optionally filtered by text");
      renderer.writeBodyLine("/new [title] Create and switch to a fresh session");
      renderer.writeBodyLine("/switch   Switch to a saved session by id, title, or list index");
      renderer.writeBodyLine("/rename   Rename the current saved session");
      renderer.writeBodyLine("/delete   Delete the current session, one session by id/title/index, or all sessions");
      renderer.writeBodyLine("/trash    Manage the local delete area without going through the model");
      renderer.writeBodyLine("/system  Edit and persist the system prompt directly in the terminal");
      renderer.writeBodyLine("/editor  Open the current system prompt in your external editor");
      renderer.writeBodyLine("/system reset Restore the built-in system prompt");
      renderer.writeBodyLine("/clear Clear the screen and redraw the header");
      renderer.writeBodyLine("/exit  Exit the session (also: exit, exit())");
      renderer.writeBodyLine("");
    },
    renderSectionTitle: (title) => {
      appendSystemLines("section", title);
    },
    renderInfo: (message) => {
      appendSystemLines("info", message);
    },
    renderError: (message) => {
      appendSystemLines("error", message);
    },
    renderWarning: (message) => {
      appendSystemLines("warning", message);
    },
    writeBodyLine: (message) => {
      appendSystemLines("body", message);
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
    },
    appendAssistantChunk: (chunk) => {
      const updated = updateLatestAgentTurn((turn) => ({
        ...turn,
        status: "streaming_answer",
        answerText: `${turn.answerText}${chunk}`,
      }));
      if (updated) {
        rerender();
      }
    },
    completeActiveTurn: () => {
      const updated = updateLatestAgentTurn((turn) => ({
        ...turn,
        status: turn.status === "failed" ? "failed" : "completed",
      }));
      if (updated) {
        rerender();
      }
    },
    failActiveTurn: (message) => {
      const updated = updateLatestAgentTurn((turn) => ({
        ...turn,
        status: "failed",
        answerText: turn.answerText ? `${turn.answerText}\n\n${message}` : message,
      }));
      if (updated) {
        rerender();
        return;
      }

      renderer.renderError(message);
    },
    applyToolEvent: (event) => {
      const updated = updateLatestAgentTurn((turn) => applyToolEventToTurn(turn, event));
      if (updated) {
        rerender();
      }
    },
    clearScreen: () => {
      state = {
        ...state,
        turns: [],
      };
      instance?.clear();
      rerender();
    },
    readPrompt: async ({ promptLabel: nextLabel, workspaceFiles }) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
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
        },
      };
      rerender();

      return new Promise<string>((resolve) => {
        promptResolver = resolve;
      });
    },
    selectOption: async (selection) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
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

      return new Promise<string | null>((resolve) => {
        overlayResolver = resolve;
      });
    },
    requestApproval: async (approval) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      const onceIndex = approval.options.findIndex((option) => option.value === "once");
      setLatestAgentInlineBlock({
        kind: "approval",
        title: approval.title,
        subtitle: approval.subtitle ?? null,
        helpText: approval.helpText ?? "Up/Down move  Enter approve once  a allow-all  Esc reject",
        options: approval.options,
        selectedIndex: onceIndex >= 0 ? onceIndex : 0,
      }, "awaiting_approval");
      state = {
        ...state,
        inputMode: "inline",
      };
      rerender();

      return new Promise<CommandApprovalDecision>((resolve) => {
        inlineApprovalResolver = resolve;
      });
    },
    reviewDiff: async (review) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
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
      }, "awaiting_approval");
      state = {
        ...state,
        inputMode: "inline",
      };
      rerender();

      return new Promise<CommandApprovalDecision>((resolve) => {
        diffResolver = resolve;
      });
    },
    viewDiff: async (review) => {
      if (promptResolver || overlayResolver || inlineApprovalResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
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
      }, getLatestAgentTurn()?.status === "failed" ? "failed" : "completed");
      state = {
        ...state,
        inputMode: "inline",
      };
      rerender();

      return new Promise<void>((resolve) => {
        diffReviewResolver = resolve;
      });
    },
    getSnapshot: () => ({
      headerLines: state.headerLines.map(cloneRendererLine),
      turns: state.turns.map(cloneRendererTurn),
      prompt: {
        label: { ...state.prompt.label },
        state: { ...state.prompt.state },
      },
      inputMode: state.inputMode,
      inputActive: state.inputMode !== "inactive",
      overlay: state.overlay
        ? {
            ...state.overlay,
            options: [...state.overlay.options],
          }
        : null,
      statusText: buildStatusText(state),
    }),
    dispatchInput: (inputValue, key) => {
      handleInput(inputValue, key);
    },
    suspend: () => {
      if (!instance) {
        return;
      }

      instance.clear();
      instance.unmount();
      instance = null;
    },
    resume: () => {
      mount();
    },
    dispose: () => {
      if (!instance) {
        return;
      }

      instance.clear();
      instance.unmount();
      instance = null;
    },
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

    if (state.inputMode === "overlay" && state.overlay) {
      handleOverlayInput(event);
      return;
    }

    if (state.inputMode === "inline") {
      handleInlineInput(event);
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
        nextComposerState = moveComposerCursor(nextComposerState, 0, promptWorkspaceFiles);
        break;
      case "move_end":
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
          return;
        }
        break;
      case "move_down":
        if (nextComposerState.suggestions.length > 0) {
          nextComposerState = moveComposerSuggestionSelection(nextComposerState, "down", promptWorkspaceFiles);
        } else {
          return;
        }
        break;
      case "cancel":
        nextComposerState = clearComposerError(nextComposerState, promptWorkspaceFiles);
        break;
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
}

function applyToolEventToTurn(
  turn: RendererAgentTurn,
  event: ToolTurnEvent,
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

function cloneRendererLine(line: RendererLine): RendererLine {
  return { ...line };
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
    return "Tab insert file  Up/Down choose  Enter submit  Esc clear";
  }

  if (state.inputMode === "prompt") {
    return "Enter submit  Ctrl+C exit";
  }

  return "Agent is working";
}

function buildDivider(output: Writable): string {
  const columns =
    "columns" in output && typeof output.columns === "number"
      ? output.columns
      : 80;
  const width = Math.min(Math.max(columns, 40), 120);
  return "-".repeat(width);
}

function getDiffViewportHeight(output: Writable): number {
  const rows =
    "rows" in output && typeof output.rows === "number"
      ? output.rows
      : 24;

  return Math.min(Math.max(rows - 16, 8), 14);
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
