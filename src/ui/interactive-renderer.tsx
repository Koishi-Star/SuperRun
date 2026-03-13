import type { Writable } from "node:stream";
import { render, type Instance, type Key } from "ink";
import React from "react";
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
  getSnapshot: () => InteractiveRendererSnapshot;
  suspend: () => void;
  resume: () => void;
  dispose: () => void;
};

type RendererState = {
  headerLines: RendererLine[];
  logLines: RendererLine[];
  prompt: RendererPrompt;
  inputActive: boolean;
};

export type InteractiveRendererSnapshot = RendererState;

export function createInteractiveRenderer(options: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}): InteractiveRenderer {
  const promptLabel = "you > ";
  const editorPromptLabel = "system > ";
  let nextLineId = 0;
  let activeAssistantLineId: string | null = null;
  let promptWorkspaceFiles: string[] = [];
  let promptResolver: ((value: string) => void) | null = null;
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
    inputActive: false,
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
      inputActive={state.inputActive}
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
      appendLines("body", "/approvals Show or switch the command approval mode (ask|allow-all|reject)");
      appendLines("body", "/settings Show the active system prompt and persistence path");
      appendLines("body", "/session  Show current session status");
      appendLines("body", "/history  Show the current or selected session transcript");
      appendLines("body", "/sessions Open the saved-session picker, optionally filtered by text");
      appendLines("body", "/new      Create and switch to a fresh session");
      appendLines("body", "/switch   Switch to a saved session by id, title, or list index");
      appendLines("body", "/rename   Rename the current saved session");
      appendLines("body", "/delete   Delete the current session, one session by id/title/index, or all sessions");
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
      // Picker flows can leave stdin paused after they tear down readline.
      // Resume before each prompt so Ink can receive keypresses again.
      options.input.resume?.();
      promptWorkspaceFiles = workspaceFiles;
      activeAssistantLineId = null;
      state = {
        ...state,
        prompt: {
          label: {
            kind: nextLabel === editorPromptLabel ? "editor" : "user",
            text: nextLabel,
          },
          state: syncComposerState(createComposerState(), workspaceFiles),
        },
        inputActive: true,
      };
      rerender();

      return new Promise<string>((resolve) => {
        promptResolver = (value) => {
          promptResolver = null;
          state = {
            ...state,
            inputActive: false,
          };
          rerender();
          resolve(value);
        };
      });
    },
    getSnapshot: () => ({
      headerLines: [...state.headerLines],
      logLines: [...state.logLines],
      prompt: {
        label: { ...state.prompt.label },
        state: { ...state.prompt.state },
      },
      inputActive: state.inputActive,
    }),
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

  const handleInput = (inputValue: string, key: Key) => {
    if (!state.inputActive || !promptResolver) {
      return;
    }

    let nextComposerState = state.prompt.state;

    if (key.ctrl && inputValue === "c") {
      const resolver = promptResolver;
      promptResolver = null;
      state = {
        ...state,
        inputActive: false,
      };
      rerender();
      resolver("/exit");
      return;
    }

    if (key.return) {
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
        const resolver = promptResolver;
        promptResolver = null;
        state = {
          ...state,
          inputActive: false,
        };
        rerender();
        resolver(submission.submittedText);
      }
      return;
    }

    if (key.backspace) {
      nextComposerState = backspaceComposerText(nextComposerState, promptWorkspaceFiles);
    } else if (key.delete) {
      nextComposerState = deleteComposerText(nextComposerState, promptWorkspaceFiles);
    } else if (key.leftArrow) {
      nextComposerState = moveComposerCursor(
        nextComposerState,
        nextComposerState.cursorIndex - 1,
        promptWorkspaceFiles,
      );
    } else if (key.rightArrow) {
      nextComposerState = moveComposerCursor(
        nextComposerState,
        nextComposerState.cursorIndex + 1,
        promptWorkspaceFiles,
      );
    } else if (key.home || (key.ctrl && inputValue === "a")) {
      nextComposerState = moveComposerCursor(nextComposerState, 0, promptWorkspaceFiles);
    } else if (key.end || (key.ctrl && inputValue === "e")) {
      nextComposerState = moveComposerCursor(
        nextComposerState,
        nextComposerState.buffer.length,
        promptWorkspaceFiles,
      );
    } else if (nextComposerState.suggestions.length > 0 && key.upArrow) {
      nextComposerState = moveComposerSuggestionSelection(nextComposerState, "up", promptWorkspaceFiles);
    } else if (nextComposerState.suggestions.length > 0 && key.downArrow) {
      nextComposerState = moveComposerSuggestionSelection(nextComposerState, "down", promptWorkspaceFiles);
    } else if (key.escape) {
      nextComposerState = clearComposerError(nextComposerState, promptWorkspaceFiles);
    } else if (key.tab) {
      nextComposerState = applySelectedComposerSuggestion(nextComposerState, promptWorkspaceFiles);
    } else if (!key.ctrl && !key.escape && inputValue) {
      nextComposerState = insertComposerText(nextComposerState, inputValue, promptWorkspaceFiles);
    } else {
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

function buildDivider(output: Writable): string {
  const columns =
    "columns" in output && typeof output.columns === "number"
      ? output.columns
      : 80;
  const width = Math.min(Math.max(columns, 40), 120);
  return "─".repeat(width);
}
