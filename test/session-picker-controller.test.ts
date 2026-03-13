import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/session/store.js";
import { buildSessionPickerChoices } from "../src/ui/session-picker.js";

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

test("session picker choice descriptions keep the preview text visible", () => {
  const choices = buildSessionPickerChoices(
    [
      createSessionSummary(1),
      createSessionSummary(2),
      createSessionSummary(3),
    ],
    "s_1",
  );

  assert.match(choices[0]?.description ?? "", /Assistant: Reply 1/);
  assert.match(choices[1]?.description ?? "", /Assistant: Reply 2/);
  assert.match(choices[2]?.description ?? "", /Assistant: Reply 3/);
});
