import "dotenv/config";
import { Command } from "commander";
import { runAgentLoop } from "./agent/loop.js";

export const program = new Command();

program
  .name("superrun")
  .description("A coding agent CLI")
  .argument("<prompt>", "prompt to send to the model")
  .action(async (prompt: string) => {
    try {
      console.log("user:", prompt);
      process.stdout.write("assistant: ");

      const reply = await runAgentLoop(prompt, {
        onChunk: (chunk) => {
          process.stdout.write(chunk);
        },
      });

      if (!reply) {
        process.stdout.write("(empty response)");
      }

      process.stdout.write("\n");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.error("error:", message);
      process.exitCode = 1;
    }
  });
