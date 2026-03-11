import type { Writable } from "node:stream";
import chalk from "chalk";

export type TerminalUI = {
  promptLabel: string;
  renderWelcome: () => void;
  renderCommands: () => void;
  renderAssistantPrefix: () => void;
  renderInfo: (message: string) => void;
  renderError: (message: string) => void;
  clearScreen: () => void;
};

export function createTerminalUI(output: Writable): TerminalUI {
  return {
    promptLabel: chalk.bold.cyan("you > "),
    renderWelcome: () => {
      output.write(`${chalk.bold.hex("#ff6b35")("SuperRun")}\n`);
      output.write(`${chalk.dim("Local coding agent interactive mode")}\n`);
      output.write(
        `${chalk.dim("Commands:")} ${chalk.cyan("/help")} ${chalk.cyan("/clear")} ${chalk.cyan("/exit")}\n\n`,
      );
    },
    renderCommands: () => {
      output.write(`${chalk.bold("Available commands")}\n`);
      output.write(`${chalk.cyan("/help")}  Show command help\n`);
      output.write(`${chalk.cyan("/clear")} Clear the screen and redraw the header\n`);
      output.write(`${chalk.cyan("/exit")}  Exit the session\n\n`);
    },
    renderAssistantPrefix: () => {
      output.write(chalk.bold.hex("#2f7d32")("superrun > "));
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
