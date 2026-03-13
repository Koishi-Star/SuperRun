import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/session/store.js";
import {
  SESSION_PICKER_EXIT_LABEL,
  buildSessionPickerChoices,
} from "../src/ui/session-picker.js";

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

test("session picker choices include the current marker and exit option", () => {
  const choices = buildSessionPickerChoices(
    [
      createSessionSummary(1),
      createSessionSummary(2),
    ],
    "s_2",
  );

  assert.equal(choices.length, 3);
  assert.deepEqual(choices[0], {
    value: "s_1",
    name: "1. Session 1",
    description: "1 turns | 10 chars | 2026-03-12 01:00 | Assistant: Reply 1",
  });
  assert.deepEqual(choices[1], {
    value: "s_2",
    name: "2. Session 2 (current)",
    description: "2 turns | 20 chars | 2026-03-12 02:00 | Assistant: Reply 2",
  });
  assert.deepEqual(choices[2], {
    value: null,
    name: SESSION_PICKER_EXIT_LABEL,
    description: "Return to chat without switching sessions.",
  });
});

test("session picker still offers an exit choice when there are no saved sessions", () => {
  const choices = buildSessionPickerChoices([], null);

  assert.deepEqual(choices, [
    {
      value: null,
      name: SESSION_PICKER_EXIT_LABEL,
      description: "Return to chat without switching sessions.",
    },
  ]);
});
