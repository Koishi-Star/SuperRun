import type { AgentMode } from "../agent/mode.js";

export const MODE_PICKER_EXIT_LABEL = "Keep current mode";

export type ModePickerChoice =
  | {
      value: AgentMode;
      name: string;
      description: string;
    }
  | {
      value: null;
      name: string;
      description: string;
    };

export function buildModePickerChoices(
  currentMode: AgentMode,
): ModePickerChoice[] {
  return [
    {
      value: "default",
      name: currentMode === "default" ? "default (current)" : "default",
      description: "Guarded command execution for inspection, build, and test tasks.",
    },
    {
      value: "strict",
      name: currentMode === "strict" ? "strict (current)" : "strict",
      description: "Specialized read-only tools only, with command execution disabled.",
    },
    {
      value: null,
      name: MODE_PICKER_EXIT_LABEL,
      description: "Return to chat without changing the current mode.",
    },
  ];
}
