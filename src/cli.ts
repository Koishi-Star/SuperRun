import { Command } from "commander";

export const program = new Command();

program
  .name("miko")
  .description("A coding agent CLI")
  .argument("<prompt>", "prompt to send to the model")
  .action(async (prompt: string) => {
    console.log("user:", prompt);
    console.log("assistant:", "这里先假装是模型返回");
  });