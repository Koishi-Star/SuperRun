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
        `${chalk.dim("Commands:")} ${chalk.cyan("/help")} ${chalk.cyan("/settings")} ${chalk.cyan("/session")} ${chalk.cyan("/resume")} ${chalk.cyan("/forget")} ${chalk.cyan("/system")} ${chalk.cyan("/clear")} ${chalk.cyan("/exit")}\n\n`,
      );
    },
    renderCommands: () => {
      output.write(`${chalk.bold("Available commands")}\n`);
      output.write(`${chalk.cyan("/help")}  Show command help\n`);
      output.write(`${chalk.cyan("/settings")} Show the active system prompt and persistence path\n`);
      output.write(`${chalk.cyan("/session")}  Show current and saved session status\n`);
      output.write(`${chalk.cyan("/resume")}   Restore the saved session into the current conversation\n`);
      output.write(`${chalk.cyan("/forget")}   Delete the saved session and clear the current conversation\n`);
      output.write(`${chalk.cyan("/system")}  Edit and persist the system prompt for future runs\n`);
      output.write(`${chalk.cyan("/system reset")} Restore the built-in system prompt\n`);
      output.write(`${chalk.cyan("/clear")} Clear the screen and redraw the header\n`);
      output.write(`${chalk.cyan("/exit")}  Exit the session\n\n`);
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
    clearScreen: () => {
      output.write("\x1Bc");
    },
  };
}
