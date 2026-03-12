import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Key } from "node:readline";
import test from "node:test";
import type { SessionSummary } from "../src/session/store.js";
import { runSessionPickerInteraction } from "../src/ui/session-picker-controller.js";
import type { SessionPickerViewModel } from "../src/ui/session-picker.js";

class FakeSessionPickerInput extends EventEmitter {
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

function createSessionSummary(index: number): SessionSummary {
  return {
    id: `s_${index}`,
    title: `Session ${index}`,
    preview: `Assistant: Reply ${index}`,
    updatedAt: `2026-03-12T0${index}:00:00.000Z`,
    turnCount: index,
    charCount: index * 10,
  };
}

test("session picker interaction selects a session from the current page", async () => {
  const input = new FakeSessionPickerInput();
  const renderCalls: SessionPickerViewModel[] = [];
  let clearCount = 0;

  const selectionPromise = runSessionPickerInteraction({
    ui: {
      clearScreen: () => {
        clearCount += 1;
      },
      renderSessionPicker: (viewModel) => {
        renderCalls.push(viewModel);
      },
    },
    input,
    sessions: [
      createSessionSummary(1),
      createSessionSummary(2),
      createSessionSummary(3),
    ],
    currentSessionId: "s_1",
  });

  input.sendKey("down");
  input.sendKey("return");

  const selectedSession = await selectionPromise;
  assert.equal(selectedSession?.id, "s_2");
  assert.deepEqual(input.rawModeChanges, [true, false]);
  assert.equal(clearCount, 2);
  assert.equal(renderCalls[0]?.options[0]?.kind, "session");
  assert.equal(renderCalls[1]?.selectedIndex, 1);
});

test("session picker interaction moves across pages before confirming", async () => {
  const input = new FakeSessionPickerInput();
  const renderCalls: SessionPickerViewModel[] = [];

  const selectionPromise = runSessionPickerInteraction({
    ui: {
      clearScreen: () => undefined,
      renderSessionPicker: (viewModel) => {
        renderCalls.push(viewModel);
      },
    },
    input,
    sessions: [
      createSessionSummary(1),
      createSessionSummary(2),
      createSessionSummary(3),
      createSessionSummary(4),
    ],
    currentSessionId: "s_1",
  });

  input.sendKey("down");
  input.sendKey("down");
  input.sendKey("down");
  input.sendKey("down");
  input.sendKey("return");

  const selectedSession = await selectionPromise;
  assert.equal(selectedSession?.id, "s_4");
  assert.equal(renderCalls.at(-1)?.pageIndex, 1);
  assert.equal(renderCalls.at(-1)?.selectedIndex, 0);
});

test("session picker interaction exits without switching on escape", async () => {
  const input = new FakeSessionPickerInput();

  const selectionPromise = runSessionPickerInteraction({
    ui: {
      clearScreen: () => undefined,
      renderSessionPicker: () => undefined,
    },
    input,
    sessions: [
      createSessionSummary(1),
      createSessionSummary(2),
    ],
    currentSessionId: "s_1",
  });

  input.sendKey("escape");

  const selectedSession = await selectionPromise;
  assert.equal(selectedSession, null);
  assert.deepEqual(input.rawModeChanges, [true, false]);
});
