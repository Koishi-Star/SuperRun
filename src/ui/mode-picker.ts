import type { AgentMode } from "../agent/mode.js";
import type { CommandApprovalMode } from "../tools/types.js";

export const MODE_PICKER_EXIT_LABEL = "Keep current mode";
export const CRAZY_AUTO_MODE_VALUE = "crazy-auto";

export type InteractiveModeChoiceValue = AgentMode | typeof CRAZY_AUTO_MODE_VALUE;

export type ModePickerChoice =
  | {
      value: InteractiveModeChoiceValue;
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
  currentApprovalMode: CommandApprovalMode,
): ModePickerChoice[] {
  const activeMode =
    currentApprovalMode === "crazy_auto" ? CRAZY_AUTO_MODE_VALUE : currentMode;

  return [
    {
      value: "default",
      name: activeMode === "default" ? "default (current)" : "default",
      description: "Guarded command execution for inspection, build, and test tasks.",
    },
    {
      value: "strict",
      name: activeMode === "strict" ? "strict (current)" : "strict",
      description: "Specialized read-only tools only, with command execution disabled.",
    },
    {
      value: CRAZY_AUTO_MODE_VALUE,
      name:
        activeMode === CRAZY_AUTO_MODE_VALUE
          ? "crazy-auto (current)"
          : "crazy-auto",
      description:
        "Default tools plus auto-approved file edits and elevated-risk shell actions.",
    },
    {
      value: null,
      name: MODE_PICKER_EXIT_LABEL,
      description: "Return to chat without changing the current mode.",
    },
  ];
}
