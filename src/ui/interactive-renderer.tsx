import type { Writable } from "node:stream";
import { render, type Instance } from "ink";
import React from "react";
import type {
  CommandApprovalDecision,
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
  kind: "info" | "error" | "warning" | "section" | "body" | "assistant";
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

export type RendererDiffOverlay = {
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

export type RendererOverlay = RendererPickerOverlay | RendererDiffOverlay;

export type RendererDiffApprovalOptions = {
  title: string;
  subtitle?: string;
  helpText?: string;
  summary: string;
  changeSummary: WorkspaceEditChangeSummary;
  truncated?: boolean;
  lines: WorkspaceEditDiffPreviewLine[];
};

export type InteractiveRenderer = {
  promptLabel: string;
  editorPromptLabel: string;
  setShellFrame: (lines: Array<Omit<RendererLine, "id">>) => void;
  renderCommands: () => void;
  renderAssistantPrefix: () => void;
  appendAssistantChunk: (chunk: string) => void;
  renderSectionTitle: (title: string) => void;
  renderInfo: (message: string) => void;
  renderError: (message: string) => void;
  renderWarning: (message: string) => void;
  writeBodyLine: (message: string) => void;
  clearScreen: () => void;
  readPrompt: (options: {
    promptLabel: string;
    workspaceFiles: string[];
  }) => Promise<string>;
  selectOption: (options: RendererSelectOptions) => Promise<string | null>;
  reviewDiff: (
    options: RendererDiffApprovalOptions,
  ) => Promise<CommandApprovalDecision>;
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

type RendererInputMode = "inactive" | "prompt" | "overlay";

type RendererState = {
  headerLines: RendererLine[];
  logLines: RendererLine[];
  prompt: RendererPrompt;
  inputMode: RendererInputMode;
  overlay: RendererOverlay | null;
};

export type InteractiveRendererSnapshot = {
  headerLines: RendererLine[];
  logLines: RendererLine[];
  prompt: RendererPrompt;
  inputMode: RendererInputMode;
  inputActive: boolean;
  overlay: RendererOverlay | null;
  statusText: string;
};

export function createInteractiveRenderer(options: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  enableInput?: boolean;
}): InteractiveRenderer {
  const promptLabel = "you > ";
  const editorPromptLabel = "system > ";
  let nextLineId = 0;
  let activeAssistantLineId: string | null = null;
  let promptWorkspaceFiles: string[] = [];
  let promptResolver: ((value: string) => void) | null = null;
  let overlayResolver: ((value: string | null) => void) | null = null;
  let diffResolver: ((value: CommandApprovalDecision) => void) | null = null;
  let diffReviewResolver: (() => void) | null = null;
  let instance: Instance | null = null;
  let state: RendererState = {
    headerLines: [],
    logLines: [],
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
      logLines={state.logLines}
      prompt={state.prompt}
      divider={buildDivider(options.output)}
      inputEnabled={options.enableInput ?? true}
      inputMode={state.inputMode}
      overlay={state.overlay}
      statusText={buildStatusText(state)}
      onInput={handleInput}
    />
  );

  const appendLines = (
    kind: RendererLine["kind"],
    message: string,
  ) => {
    const lines = message.split(/\r?\n/);
    state = {
      ...state,
      logLines: [
        ...state.logLines,
        ...lines.map((text) => ({
          id: `line_${nextLineId += 1}`,
          kind,
          text,
        })),
      ],
    };
    rerender();
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

  const resolveDiffReview = () => {
    const resolver = diffReviewResolver;
    diffReviewResolver = null;
    state = {
      ...state,
      inputMode: "inactive",
      overlay: null,
    };
    rerender();
    resolver?.();
  };

  const resolveDiff = (value: CommandApprovalDecision) => {
    const resolver = diffResolver;
    diffResolver = null;
    state = {
      ...state,
      inputMode: "inactive",
      overlay: null,
    };
    rerender();
    resolver?.(value);
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
      appendLines("section", "Available commands");
      appendLines("body", "/help  Show command help");
      appendLines("body", "/mode     Show or switch the active tool mode (default|strict)");
      appendLines("body", "/approvals Show or switch the approval mode for file edits and commands (ask|allow-all|crazy_auto|reject)");
      appendLines("body", "/settings Show the active system prompt and persistence path");
      appendLines("body", "/session  Show current session status");
      appendLines("body", "/history  Show the current or selected session transcript and events");
      appendLines("body", "/sessions Open the saved-session picker, optionally filtered by text");
      appendLines("body", "/new      Create and switch to a fresh session");
      appendLines("body", "/switch   Switch to a saved session by id, title, or list index");
      appendLines("body", "/rename   Rename the current saved session");
      appendLines("body", "/delete   Delete the current session, one session by id/title/index, or all sessions");
      appendLines("body", "/trash    Manage the local delete area without going through the model");
      appendLines("body", "/system  Edit and persist the system prompt directly in the terminal");
      appendLines("body", "/editor  Open the current system prompt in your external editor");
      appendLines("body", "/system reset Restore the built-in system prompt");
      appendLines("body", "/clear Clear the screen and redraw the header");
      appendLines("body", "/exit  Exit the session (also: exit, exit())");
      appendLines("body", "");
    },
    renderAssistantPrefix: () => {
      if (activeAssistantLineId) {
        return;
      }

      const lineId = `assistant_${nextLineId += 1}`;
      activeAssistantLineId = lineId;
      state = {
        ...state,
        logLines: [
          ...state.logLines,
          {
            id: lineId,
            kind: "assistant",
            text: "",
          },
        ],
      };
      rerender();
    },
    appendAssistantChunk: (chunk) => {
      if (!activeAssistantLineId) {
        renderer.renderAssistantPrefix();
      }

      if (!activeAssistantLineId) {
        return;
      }

      state = {
        ...state,
        logLines: state.logLines.map((line) =>
          line.id === activeAssistantLineId
            ? {
                ...line,
                text: `${line.text}${chunk}`,
              }
            : line,
        ),
      };
      rerender();
    },
    renderSectionTitle: (title) => {
      appendLines("section", title);
    },
    renderInfo: (message) => {
      appendLines("info", message);
    },
    renderError: (message) => {
      appendLines("error", message);
    },
    renderWarning: (message) => {
      appendLines("warning", message);
    },
    writeBodyLine: (message) => {
      appendLines("body", message);
    },
    clearScreen: () => {
      state = {
        ...state,
        logLines: [],
      };
      activeAssistantLineId = null;
      instance?.clear();
      rerender();
    },
    readPrompt: async ({ promptLabel: nextLabel, workspaceFiles }) => {
      if (promptResolver || overlayResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      // External terminal tools can leave stdin paused after they tear down readline.
      // Resume before each prompt so Ink can receive keypresses again.
      options.input.resume?.();
      promptWorkspaceFiles = workspaceFiles;
      activeAssistantLineId = null;
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
      if (promptResolver || overlayResolver || diffResolver || diffReviewResolver) {
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
    reviewDiff: async (review) => {
      if (promptResolver || overlayResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      state = {
        ...state,
        inputMode: "overlay",
        overlay: {
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
        },
      };
      rerender();

      return new Promise<CommandApprovalDecision>((resolve) => {
        diffResolver = resolve;
      });
    },
    viewDiff: async (review) => {
      if (promptResolver || overlayResolver || diffResolver || diffReviewResolver) {
        throw new Error("Interactive renderer is already waiting for input.");
      }

      state = {
        ...state,
        inputMode: "overlay",
        overlay: {
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
        },
      };
      rerender();

      return new Promise<void>((resolve) => {
        diffReviewResolver = resolve;
      });
    },
    getSnapshot: () => ({
      headerLines: [...state.headerLines],
      logLines: [...state.logLines],
      prompt: {
        label: { ...state.prompt.label },
        state: { ...state.prompt.state },
      },
      inputMode: state.inputMode,
      inputActive: state.inputMode !== "inactive",
      overlay: state.overlay
        ? state.overlay.kind === "picker"
          ? {
              ...state.overlay,
              options: [...state.overlay.options],
            }
          : {
              ...state.overlay,
              lines: [...state.overlay.lines],
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

    if (state.inputMode !== "prompt" || !promptResolver) {
      return;
    }

    handlePromptInput(event);
  };

  const handleOverlayInput = (event: ReturnType<typeof normalizeInkInput>) => {
    if (!event || !state.overlay) {
      return;
    }

    if (state.overlay.kind === "diff") {
      handleDiffOverlayInput(event);
      return;
    }

    if (!overlayResolver) {
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

  const handleDiffOverlayInput = (event: ReturnType<typeof normalizeInkInput>) => {
    if (!event || !state.overlay || state.overlay.kind !== "diff") {
      return;
    }

    if (state.overlay.mode === "review") {
      if (event.type === "interrupt" || event.type === "cancel" || event.type === "submit") {
        resolveDiffReview();
        return;
      }
    } else if (!diffResolver) {
      return;
    }

    if (state.overlay.mode === "approval" && (event.type === "interrupt" || event.type === "cancel")) {
      resolveDiff("reject");
      return;
    }

    if (state.overlay.mode === "approval" && event.type === "submit") {
      resolveDiff("once");
      return;
    }

    if (state.overlay.mode === "approval" && event.type === "insert_text") {
      const normalizedText = event.text.trim().toLowerCase();
      if (normalizedText === "a") {
        resolveDiff("always");
        return;
      }

      if (normalizedText === "r") {
        resolveDiff("reject");
      }
      return;
    }

    switch (event.type) {
      case "move_up":
        state = {
          ...state,
          overlay: moveDiffScroll(state.overlay, -1),
        };
        rerender();
        return;
      case "move_down":
        state = {
          ...state,
          overlay: moveDiffScroll(state.overlay, 1),
        };
        rerender();
        return;
      case "move_page_up":
        state = {
          ...state,
          overlay: moveDiffScroll(state.overlay, -state.overlay.viewportHeight),
        };
        rerender();
        return;
      case "move_page_down":
        state = {
          ...state,
          overlay: moveDiffScroll(state.overlay, state.overlay.viewportHeight),
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

function moveOverlaySelection(
  overlay: RendererPickerOverlay,
  delta: number,
): RendererPickerOverlay {
  if (overlay.options.length === 0) {
    return overlay;
  }

  const nextIndex =
    (overlay.selectedIndex + delta + overlay.options.length) % overlay.options.length;

  return {
    ...overlay,
    selectedIndex: nextIndex,
  };
}

function moveDiffScroll(
  overlay: RendererDiffOverlay,
  delta: number,
): RendererDiffOverlay {
  const maxOffset = Math.max(0, overlay.lines.length - overlay.viewportHeight);
  return {
    ...overlay,
    scrollOffset: Math.min(Math.max(overlay.scrollOffset + delta, 0), maxOffset),
  };
}

function buildStatusText(state: RendererState): string {
  if (state.inputMode === "overlay") {
    if (state.overlay?.kind === "diff") {
      return state.overlay.helpText ?? (
        state.overlay.mode === "approval"
          ? "Up/Down scroll  Enter approve once  Esc reject"
          : "Up/Down scroll  Enter close  Esc close"
      );
    }

    return state.overlay?.helpText ?? "Up/Down move  Enter select  Esc cancel";
  }

  if (state.prompt.state.activeReference) {
    return "Tab insert file  Up/Down choose  Enter submit  Esc clear";
  }

  return "Enter submit  Ctrl+C exit";
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

  return Math.min(Math.max(rows - 14, 6), 18);
}
