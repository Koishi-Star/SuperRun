import "dotenv/config";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  createAgentSession,
  runAgentTurn,
} from "./agent/loop.js";
import { createTerminalUI, type TerminalUI } from "./ui/tui.js";

export const program = new Command();

program
  .name("superrun")
  .description("A coding agent CLI")
  .argument("[prompt]", "prompt to send to the model")
  .action(async (prompt?: string) => {
    try {
      const session = createAgentSession();
      const trimmedPrompt = prompt?.trim();

      if (trimmedPrompt) {
        await runSingleTurn(session, trimmedPrompt);
        return;
      }

      await runInteractiveSession(session);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.error("error:", message);
      process.exitCode = 1;
    }
  });

async function runSingleTurn(
  session: ReturnType<typeof createAgentSession>,
  prompt: string,
): Promise<void> {
  console.log("user:", prompt);
  process.stdout.write("assistant: ");

  const reply = await runAgentTurn(session, prompt, {
    onChunk: (chunk) => {
      process.stdout.write(chunk);
    },
  });

  if (!reply) {
    process.stdout.write("(empty response)");
  }

  process.stdout.write("\n");
}

async function runInteractiveSession(
  session: ReturnType<typeof createAgentSession>,
): Promise<void> {
  const rl = createInterface({ input, output });
  // Keep piped/non-interactive usage plain, but enable a richer prompt in a real terminal.
  const ui = input.isTTY && output.isTTY ? createTerminalUI(output) : null;

  if (ui) {
    ui.renderWelcome();
  } else {
    console.log('Interactive mode. Type "/exit" to quit.');
  }

  try {
    if (ui) {
      while (true) {
        let prompt: string;

        try {
          prompt = (await rl.question(ui.promptLabel)).trim();
        } catch (error) {
          if (isReadlineClosedError(error)) {
            break;
          }
          throw error;
        }

        if (!(await handleInteractivePrompt(session, prompt, ui))) {
          break;
        }
      }
      return;
    }

    for await (const line of rl) {
      if (!(await handleInteractivePrompt(session, line.trim(), ui))) {
        break;
      }
    }
  } finally {
    rl.close();
  }
}

async function handleInteractivePrompt(
  session: ReturnType<typeof createAgentSession>,
  prompt: string,
  ui: TerminalUI | null,
): Promise<boolean> {
  if (!prompt) {
    return true;
  }

  if (prompt === "/exit") {
    return false;
  }

  // Handle local UI commands before sending anything to the model.
  if (prompt === "/help") {
    if (ui) {
      ui.renderCommands();
    } else {
      console.log("Commands: /help /clear /exit");
    }
    return true;
  }

  if (prompt === "/clear") {
    if (ui) {
      ui.clearScreen();
      ui.renderWelcome();
    }
    return true;
  }

  if (ui) {
    ui.renderAssistantPrefix();
  } else {
    process.stdout.write("assistant: ");
  }

  const reply = await runAgentTurn(session, prompt, {
    onChunk: (chunk) => {
      process.stdout.write(chunk);
    },
  });

  if (!reply) {
    process.stdout.write("(empty response)");
  }

  process.stdout.write("\n");
  return true;
}

function isReadlineClosedError(error: unknown): boolean {
  return error instanceof Error && error.message === "readline was closed";
}
