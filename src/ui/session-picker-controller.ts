import type { Key } from "node:readline";
import type { SessionSummary } from "../session/store.js";
import {
  createSessionPickerState,
  getSessionPickerViewModel,
  moveSessionPicker,
} from "./session-picker.js";
import type { TerminalUI } from "./tui.js";

export type SessionPickerInput = {
  isRaw?: boolean;
  setRawMode: (mode: boolean) => void;
  on: (
    event: "keypress",
    listener: (value: string, key: Key) => void,
  ) => void;
  off: (
    event: "keypress",
    listener: (value: string, key: Key) => void,
  ) => void;
};

export async function runSessionPickerInteraction(options: {
  ui: Pick<TerminalUI, "clearScreen" | "renderSessionPicker">;
  input: SessionPickerInput;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  filterQuery?: string | null | undefined;
}): Promise<SessionSummary | null> {
  const {
    ui,
    input,
    sessions,
    currentSessionId,
    filterQuery,
  } = options;
  let pickerState = createSessionPickerState();
  const previousRawMode = input.isRaw === true;

  render();

  return new Promise((resolve) => {
    const finish = (result: SessionSummary | null) => {
      input.off("keypress", onKeypress);
      if (!previousRawMode) {
        input.setRawMode(false);
      }
      resolve(result);
    };

    const onKeypress = (_value: string, key: Key) => {
      const direction = getSessionPickerDirection(key);
      if (direction) {
        pickerState = moveSessionPicker(pickerState, sessions, direction);
        render();
        return;
      }

      if (key.name === "return") {
        const viewModel = getSessionPickerViewModel(
          sessions,
          currentSessionId,
          pickerState,
          { filterQuery },
        );
        const selectedOption = viewModel.options[pickerState.selectedIndex];
        finish(selectedOption?.kind === "session" ? selectedOption.session : null);
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
    ui.renderSessionPicker(
      getSessionPickerViewModel(
        sessions,
        currentSessionId,
        pickerState,
        { filterQuery },
      ),
    );
  }
}

function getSessionPickerDirection(
  key: Key,
): "up" | "down" | "left" | "right" | null {
  if (key.name === "up") {
    return "up";
  }

  if (key.name === "down") {
    return "down";
  }

  if (key.name === "left") {
    return "left";
  }

  if (key.name === "right") {
    return "right";
  }

  return null;
}
