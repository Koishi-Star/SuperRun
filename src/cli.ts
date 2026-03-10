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
      const reply = await runAgentLoop(prompt);
      console.log("assistant:", reply);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.error("error:", message);
      process.exitCode = 1;
    }
  });
