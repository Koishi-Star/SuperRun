import { select } from "@inquirer/prompts";
import type { AgentMode } from "../agent/mode.js";
import { isPromptExitError } from "./inquirer-errors.js";
import { buildModePickerChoices } from "./mode-picker.js";

export async function runModePickerInteraction(options: {
  currentMode: AgentMode;
}): Promise<AgentMode | null> {
  const choices = buildModePickerChoices(options.currentMode);

  try {
    return await select<AgentMode | null>({
      message: "Choose the active tool mode",
      choices: choices.map((choice) => ({
        value: choice.value,
        name: choice.name,
        description: choice.description,
      })),
      pageSize: choices.length,
    });
  } catch (error) {
    if (isPromptExitError(error)) {
      return null;
    }

    throw error;
  }
}
