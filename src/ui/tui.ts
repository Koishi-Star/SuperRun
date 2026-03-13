import type { Writable } from "node:stream";
import chalk from "chalk";
export type TerminalUI = {
  promptLabel: string;
  editorPromptLabel: string;
  renderWelcome: () => void;
  renderCommands: () => void;
  renderAssistantPrefix: () => void;
  renderSectionTitle: (title: string) => void;
  renderInfo: (message: string) => void;
  renderError: (message: string) => void;
  renderWarning: (message: string) => void;
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
        `${chalk.dim("Commands:")} ${chalk.cyan("/help")} ${chalk.cyan("/mode")} ${chalk.cyan("/approvals")} ${chalk.cyan("/history")} ${chalk.cyan("/sessions")} ${chalk.cyan("/new")} ${chalk.cyan("/switch")} ${chalk.cyan("/rename")} ${chalk.cyan("/delete")} ${chalk.cyan("/system")} ${chalk.cyan("/editor")} ${chalk.cyan("/clear")} ${chalk.cyan("/exit")}\n\n`,
      );
    },
    renderCommands: () => {
      output.write(`${chalk.bold("Available commands")}\n`);
      output.write(`${chalk.cyan("/help")}  Show command help\n`);
      output.write(`${chalk.cyan("/mode")}     Show or switch the active tool mode (default|strict)\n`);
      output.write(`${chalk.cyan("/approvals")} Show or switch the command approval mode (ask|allow-all|reject)\n`);
      output.write(`${chalk.cyan("/settings")} Show the active system prompt and persistence path\n`);
      output.write(`${chalk.cyan("/session")}  Show current session status\n`);
      output.write(`${chalk.cyan("/history")}  Show the current or selected session transcript\n`);
      output.write(`${chalk.cyan("/sessions")} Open the saved-session picker, optionally filtered by text\n`);
      output.write(`${chalk.cyan("/new")}      Create and switch to a fresh session\n`);
      output.write(`${chalk.cyan("/switch")}   Switch to a saved session by id, title, or list index\n`);
      output.write(`${chalk.cyan("/rename")}   Rename the current saved session\n`);
      output.write(`${chalk.cyan("/delete")}   Delete the current session, one session by id/title/index, or all sessions\n`);
      output.write(`${chalk.cyan("/system")}  Edit and persist the system prompt directly in the terminal\n`);
      output.write(`${chalk.cyan("/editor")}  Open the current system prompt in your external editor\n`);
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
    renderInfo: (message: string) => {
      output.write(`${chalk.dim(message)}\n`);
    },
    renderError: (message: string) => {
      output.write(`${chalk.bold.red("error:")} ${message}\n`);
    },
    renderWarning: (message: string) => {
      output.write(`${chalk.bold.hex("#ffb703")(message)}\n`);
    },
    clearScreen: () => {
      output.write("\x1Bc");
    },
  };
}
