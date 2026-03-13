import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Key } from "node:readline";
import test from "node:test";
import type { ModePickerViewModel } from "../src/ui/mode-picker.js";
import { runModePickerInteraction } from "../src/ui/mode-picker-controller.js";

class FakeModePickerInput extends EventEmitter {
  isRaw = false;
  rawModeChanges: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModeChanges.push(mode);
  }

  sendKey(name: Key["name"], options?: Partial<Key>): void {
    this.emit("keypress", "", {
      name,
      ...options,
    } as Key);
  }
}

test("mode picker confirms the highlighted mode", async () => {
  const input = new FakeModePickerInput();
  const renderCalls: ModePickerViewModel[] = [];

  const selectionPromise = runModePickerInteraction({
    ui: {
      clearScreen: () => undefined,
      renderModePicker: (viewModel) => {
        renderCalls.push(viewModel);
      },
    },
    input,
    currentMode: "default",
  });

  input.sendKey("down");
  input.sendKey("return");

  const selectedMode = await selectionPromise;
  assert.equal(selectedMode, "strict");
  assert.deepEqual(input.rawModeChanges, [true, false]);
  assert.equal(renderCalls[0]?.options[0]?.kind, "mode");
  assert.equal(renderCalls[1]?.selectedIndex, 1);
});

test("mode picker exits without changing mode on escape", async () => {
  const input = new FakeModePickerInput();

  const selectionPromise = runModePickerInteraction({
    ui: {
      clearScreen: () => undefined,
      renderModePicker: () => undefined,
    },
    input,
    currentMode: "strict",
  });

  input.sendKey("escape");

  const selectedMode = await selectionPromise;
  assert.equal(selectedMode, null);
  assert.deepEqual(input.rawModeChanges, [true, false]);
});
