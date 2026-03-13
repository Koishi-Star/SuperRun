import type { Key } from "node:readline";
import type { Writable } from "node:stream";
import chalk from "chalk";
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
} from "./composer-state.js";
import { getDisplayWidth } from "./text-width.js";

export type TTYPromptInput = {
  isRaw?: boolean;
  resume?: () => void;
  setRawMode: (mode: boolean) => void;
  on: (
    event: "keypress",
    listener: (value: string, key: Key) => void,
  ) => void;
  off: (
    event: "keypress",
    listener: (value: string, key: Key) => void,
  ) => void;
};

export async function readTTYPrompt(options: {
  input: TTYPromptInput;
  output: Writable;
  promptLabel: string;
  workspaceFiles: string[];
}): Promise<string> {
  const { input, output, promptLabel, workspaceFiles } = options;
  let state = syncComposerState(createComposerState(), workspaceFiles);
  let renderedLineCount = 0;
  let renderedPromptLineIndex = 0;
  const previousRawMode = input.isRaw === true;

  // Inquirer closes its readline interface after pickers finish, which can
  // leave stdin paused. Resume before every composer read so TTY mode stays
  // alive after commands like /sessions and /mode.
  input.resume?.();
  render();

  return new Promise((resolve) => {
    const finish = (value: string) => {
      input.off("keypress", onKeypress);
      render(true);
      output.write("\n");
      if (!previousRawMode) {
        input.setRawMode(false);
      }
      resolve(value);
    };

    const onKeypress = (value: string, key: Key): void => {
      if (key.ctrl && key.name === "c") {
        finish("/exit");
        return;
      }

      if (key.name === "return") {
        const submission = submitComposer(state, workspaceFiles);
        state = submission.state;
        render();

        if (submission.submittedText !== null) {
          finish(submission.submittedText);
        }
        return;
      }

      if (key.name === "backspace") {
        state = backspaceComposerText(state, workspaceFiles);
        render();
        return;
      }

      if (key.name === "delete") {
        state = deleteComposerText(state, workspaceFiles);
        render();
        return;
      }

      if (key.name === "left") {
        state = moveComposerCursor(state, state.cursorIndex - 1, workspaceFiles);
        render();
        return;
      }

      if (key.name === "right") {
        state = moveComposerCursor(state, state.cursorIndex + 1, workspaceFiles);
        render();
        return;
      }

      if (key.name === "home" || (key.ctrl && key.name === "a")) {
        state = moveComposerCursor(state, 0, workspaceFiles);
        render();
        return;
      }

      if (key.name === "end" || (key.ctrl && key.name === "e")) {
        state = moveComposerCursor(state, state.buffer.length, workspaceFiles);
        render();
        return;
      }

      if (state.suggestions.length > 0 && key.name === "up") {
        state = moveComposerSuggestionSelection(state, "up", workspaceFiles);
        render();
        return;
      }

      if (state.suggestions.length > 0 && key.name === "down") {
        state = moveComposerSuggestionSelection(state, "down", workspaceFiles);
        render();
        return;
      }

      if (key.name === "escape") {
        state = clearComposerError(state, workspaceFiles);
        render();
        return;
      }

      if (key.name === "tab") {
        state = applySelectedComposerSuggestion(state, workspaceFiles);
        render();
        return;
      }

      if (!key.ctrl && key.name !== "escape" && value) {
        state = insertComposerText(state, value, workspaceFiles);
        render();
      }
    };

    input.on("keypress", onKeypress);
    if (!previousRawMode) {
      input.setRawMode(true);
    }
  });

  function render(finalLineOnly = false): void {
    clearRenderedBlock(output, renderedPromptLineIndex);

    const lines = finalLineOnly
      ? [`${promptLabel}${state.buffer}`]
      : formatComposerLines({
          output,
          promptLabel,
          promptText: state.buffer,
          errorMessage: state.errorMessage,
          suggestions: state.suggestions,
          activeQuery: state.activeReference?.query ?? null,
          selectedSuggestionIndex: state.selectedSuggestionIndex,
        });

    output.write(lines.join("\n"));
    renderedLineCount = lines.length;
    renderedPromptLineIndex = finalLineOnly ? 0 : 1;
    moveCursorToPrompt(output, {
      renderedLineCount,
      promptLineIndex: renderedPromptLineIndex,
      promptWidth: getDisplayWidth(promptLabel),
      cursorWidth: getDisplayWidth(state.buffer.slice(0, state.cursorIndex)),
    });
  }
}

function formatComposerLines(options: {
  output: Writable;
  promptLabel: string;
  promptText: string;
  errorMessage: string | null;
  suggestions: string[];
  activeQuery: string | null;
  selectedSuggestionIndex: number;
}): string[] {
  return [
    `${options.promptLabel}${options.promptText}`,
    ...formatErrorLine(options.errorMessage),
    ...formatSuggestionLines(
      options.suggestions,
      options.activeQuery,
      options.selectedSuggestionIndex,
    ),
  ];
}

function formatErrorLine(errorMessage: string | null): string[] {
  return errorMessage ? [chalk.bold.red(`  ${errorMessage}`)] : [];
}

function formatSuggestionLines(
  matches: string[],
  query: string | null,
  selectedSuggestionIndex: number,
): string[] {
  if (query === null) {
    return [];
  }

  if (matches.length === 0) {
    return [chalk.dim(`  No files match "@${query}".`)];
  }

  const lines = [
    chalk.dim("  @ files - Up/Down to choose, Tab to insert"),
  ];

  for (const [index, match] of matches.entries()) {
    const selected = index === selectedSuggestionIndex;
    const line = `${selected ? ">" : " "} ${match}`;
    lines.push(selected ? chalk.inverse(line) : chalk.dim(line));
  }

  return lines;
}

function clearRenderedBlock(
  output: Writable,
  promptLineIndex: number,
): void {
  if (promptLineIndex > 0) {
    output.write(`\u001B[${promptLineIndex}A`);
  }
  output.write("\r");
  output.write("\u001B[2K");
  output.write("\u001B[J");
}

function moveCursorToPrompt(
  output: Writable,
  options: {
    renderedLineCount: number;
    promptLineIndex: number;
    promptWidth: number;
    cursorWidth: number;
  },
): void {
  const {
    renderedLineCount,
    promptLineIndex,
    promptWidth,
    cursorWidth,
  } = options;
  const linesBelowPrompt = renderedLineCount - 1 - promptLineIndex;

  if (linesBelowPrompt > 0) {
    output.write(`\u001B[${linesBelowPrompt}A`);
  }
  output.write("\r");
  if (promptWidth + cursorWidth > 0) {
    output.write(`\u001B[${promptWidth + cursorWidth}C`);
  }
}

function getComposerWidth(output: Writable): number {
  const columns =
    "columns" in output && typeof output.columns === "number"
      ? output.columns
      : 80;

  return Math.min(Math.max(columns, 40), 120);
}
