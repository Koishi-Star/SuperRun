import type { Writable } from "node:stream";
import chalk from "chalk";
import type { SessionPickerViewModel } from "./session-picker.js";

export type TerminalUI = {
  promptLabel: string;
  editorPromptLabel: string;
  renderWelcome: () => void;
  renderCommands: () => void;
  renderAssistantPrefix: () => void;
  renderSectionTitle: (title: string) => void;
  renderSessionPicker: (viewModel: SessionPickerViewModel) => void;
  renderInfo: (message: string) => void;
  renderError: (message: string) => void;
  clearScreen: () => void;
};

export function createTerminalUI(output: Writable): TerminalUI {
  return {
    promptLabel: chalk.bold.cyan("you > "),
    editorPromptLabel: chalk.bold.yellow("system > "),
    renderWelcome: () => {
      output.write(`${chalk.bold.hex("#ff6b35")("SuperRun")}\n`);
      output.write(`${chalk.dim("Local coding agent interactive mode")}\n`);
      output.write(
        `${chalk.dim("Commands:")} ${chalk.cyan("/help")} ${chalk.cyan("/history")} ${chalk.cyan("/sessions")} ${chalk.cyan("/new")} ${chalk.cyan("/switch")} ${chalk.cyan("/rename")} ${chalk.cyan("/delete")} ${chalk.cyan("/system")} ${chalk.cyan("/clear")} ${chalk.cyan("/exit")}\n\n`,
      );
    },
    renderCommands: () => {
      output.write(`${chalk.bold("Available commands")}\n`);
      output.write(`${chalk.cyan("/help")}  Show command help\n`);
      output.write(`${chalk.cyan("/settings")} Show the active system prompt and persistence path\n`);
      output.write(`${chalk.cyan("/session")}  Show current session status\n`);
      output.write(`${chalk.cyan("/history")}  Show the current or selected session transcript\n`);
      output.write(`${chalk.cyan("/sessions")} Open the saved-session picker, optionally filtered by text\n`);
      output.write(`${chalk.cyan("/new")}      Create and switch to a fresh session\n`);
      output.write(`${chalk.cyan("/switch")}   Switch to a saved session by id, title, or list index\n`);
      output.write(`${chalk.cyan("/rename")}   Rename the current saved session\n`);
      output.write(`${chalk.cyan("/delete")}   Delete the current session or a session by id/title/index\n`);
      output.write(`${chalk.cyan("/system")}  Edit and persist the system prompt for future runs\n`);
      output.write(`${chalk.cyan("/system reset")} Restore the built-in system prompt\n`);
      output.write(`${chalk.cyan("/clear")} Clear the screen and redraw the header\n`);
      output.write(`${chalk.cyan("/exit")}  Exit the session (also: exit, exit())\n\n`);
    },
    renderAssistantPrefix: () => {
      output.write(chalk.bold.hex("#2f7d32")("superrun > "));
    },
    renderSectionTitle: (title: string) => {
      output.write(`${chalk.bold(title)}\n`);
    },
    renderSessionPicker: (viewModel: SessionPickerViewModel) => {
      const width = getFrameWidth(output);
      const divider = `+${"-".repeat(width - 2)}+`;
      const lines: string[] = [
        divider,
        formatFrameLine(
          width,
          `Session Picker`,
          `Page ${viewModel.pageIndex + 1}/${viewModel.totalPages}`,
        ),
        divider,
        formatFrameTextLine(
          width,
          "Use arrows to move, Enter to switch, and q/Esc to return.",
        ),
        divider,
      ];

      if (viewModel.filterQuery) {
        lines.push(
          formatFrameTextLine(
            width,
            `Filter: "${viewModel.filterQuery}" (${viewModel.resultCount} match${viewModel.resultCount === 1 ? "" : "es"})`,
          ),
        );
        lines.push(divider);
      }

      if (viewModel.options.length === 1 && viewModel.options[0]?.kind === "exit") {
        lines.push(
          formatFrameTextLine(
            width,
            viewModel.filterQuery
              ? `No saved sessions match "${viewModel.filterQuery}".`
              : "No saved sessions yet.",
          ),
        );
        lines.push(formatFrameTextLine(width, ""));
      }

      for (const [index, option] of viewModel.options.entries()) {
        const selected = index === viewModel.selectedIndex;

        if (option.kind === "session") {
          const suffix = option.isCurrent ? " (current)" : "";
          lines.push(
            formatPickerOptionLine(
              width,
              `${selected ? ">" : " "} ${option.globalIndex}. ${option.session.title} [${option.session.id}]${suffix}`,
              selected,
            ),
          );
          lines.push(
            formatFrameTextLine(
              width,
              `  ${option.session.turnCount} turns | ${option.session.charCount} chars | ${formatTimestamp(option.session.updatedAt)}`,
            ),
          );
          lines.push(
            formatFrameTextLine(width, `  ${option.session.preview}`),
          );
          lines.push(formatFrameTextLine(width, ""));
          continue;
        }

        lines.push(
          formatPickerOptionLine(
            width,
            `${selected ? ">" : " "} ${option.label}`,
            selected,
          ),
        );
      }

      lines.push(divider);
      output.write(`${lines.join("\n")}\n`);
    },
    renderInfo: (message: string) => {
      output.write(`${chalk.dim(message)}\n`);
    },
    renderError: (message: string) => {
      output.write(`${chalk.bold.red("error:")} ${message}\n`);
    },
    clearScreen: () => {
      output.write("\x1Bc");
    },
  };
}

function getFrameWidth(output: Writable): number {
  const columns =
    "columns" in output && typeof output.columns === "number"
      ? output.columns
      : 80;
  return Math.min(Math.max(columns, 56), 100);
}

function formatFrameLine(
  width: number,
  leftText: string,
  rightText: string,
): string {
  const innerWidth = width - 4;
  const availableLeftWidth = Math.max(0, innerWidth - rightText.length - 1);
  const left = truncateForFrame(leftText, availableLeftWidth);
  const spacing = Math.max(1, innerWidth - left.length - rightText.length);
  return `| ${left}${" ".repeat(spacing)}${rightText} |`;
}

function formatPickerOptionLine(
  width: number,
  text: string,
  selected: boolean,
): string {
  const line = formatFrameTextLine(width, text);
  return selected ? chalk.inverse(line) : line;
}

function formatFrameTextLine(width: number, text: string): string {
  const innerWidth = width - 4;
  const normalizedText = truncateForFrame(text, innerWidth);
  return `| ${normalizedText.padEnd(innerWidth, " ")} |`;
}

function truncateForFrame(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16);
}
