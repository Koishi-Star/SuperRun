import type { Key } from "node:readline";
import type { AgentMode } from "../agent/mode.js";
import {
  createModePickerState,
  getModePickerViewModel,
  moveModePicker,
} from "./mode-picker.js";
import type { SessionPickerInput } from "./session-picker-controller.js";
import type { TerminalUI } from "./tui.js";

export async function runModePickerInteraction(options: {
  ui: Pick<TerminalUI, "clearScreen" | "renderModePicker">;
  input: SessionPickerInput;
  currentMode: AgentMode;
}): Promise<AgentMode | null> {
  const { ui, input, currentMode } = options;
  let pickerState = createModePickerState(currentMode);
  const previousRawMode = input.isRaw === true;

  render();

  return new Promise((resolve) => {
    const finish = (result: AgentMode | null) => {
      input.off("keypress", onKeypress);
      if (!previousRawMode) {
        input.setRawMode(false);
      }
      resolve(result);
    };

    const onKeypress = (_value: string, key: Key) => {
      if (key.name === "up" || key.name === "down") {
        pickerState = moveModePicker(pickerState, currentMode, key.name);
        render();
        return;
      }

      if (key.name === "return") {
        const selectedOption = getModePickerViewModel(
          currentMode,
          pickerState,
        ).options[pickerState.selectedIndex];
        finish(selectedOption?.kind === "mode" ? selectedOption.mode : null);
        return;
      }

      if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        finish(null);
      }
    };

    input.on("keypress", onKeypress);
    if (!previousRawMode) {
      input.setRawMode(true);
    }
  });

  function render(): void {
    ui.clearScreen();
    ui.renderModePicker(getModePickerViewModel(currentMode, pickerState));
  }
}
