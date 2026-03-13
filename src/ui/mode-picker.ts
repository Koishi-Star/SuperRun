import type { AgentMode } from "../agent/mode.js";

export const MODE_PICKER_EXIT_LABEL = "Keep current mode";

export type ModePickerState = {
  selectedIndex: number;
};

export type ModePickerOption =
  | {
      kind: "mode";
      mode: AgentMode;
      label: string;
      description: string;
      isCurrent: boolean;
    }
  | {
      kind: "exit";
      label: string;
    };

export type ModePickerViewModel = {
  selectedIndex: number;
  options: ModePickerOption[];
};

export function createModePickerState(currentMode: AgentMode): ModePickerState {
  return {
    selectedIndex: getModeOptions(currentMode).findIndex(
      (option) => option.kind === "mode" && option.isCurrent,
    ),
  };
}

export function getModePickerViewModel(
  currentMode: AgentMode,
  state: ModePickerState,
): ModePickerViewModel {
  const options = getModeOptions(currentMode);
  const selectedIndex = clamp(state.selectedIndex, 0, options.length - 1);

  return {
    selectedIndex,
    options,
  };
}

export function moveModePicker(
  state: ModePickerState,
  currentMode: AgentMode,
  direction: "up" | "down",
): ModePickerState {
  const options = getModeOptions(currentMode);
  const lastIndex = options.length - 1;

  if (direction === "up") {
    return {
      selectedIndex: clamp(state.selectedIndex - 1, 0, lastIndex),
    };
  }

  return {
    selectedIndex: clamp(state.selectedIndex + 1, 0, lastIndex),
  };
}

function getModeOptions(currentMode: AgentMode): ModePickerOption[] {
  return [
    {
      kind: "mode",
      mode: "default",
      label: "default",
      description: "Guarded command execution for inspection, build, and test tasks.",
      isCurrent: currentMode === "default",
    },
    {
      kind: "mode",
      mode: "strict",
      label: "strict",
      description: "Specialized read-only tools only, with command execution disabled.",
      isCurrent: currentMode === "strict",
    },
    {
      kind: "exit",
      label: MODE_PICKER_EXIT_LABEL,
    },
  ];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
