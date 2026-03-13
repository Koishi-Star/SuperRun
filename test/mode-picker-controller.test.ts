import assert from "node:assert/strict";
import test from "node:test";
import {
  MODE_PICKER_EXIT_LABEL,
  buildModePickerChoices,
} from "../src/ui/mode-picker.js";

test("mode picker choices mark the active mode and include an exit option", () => {
  const choices = buildModePickerChoices("default");

  assert.deepEqual(choices, [
    {
      value: "default",
      name: "default (current)",
      description: "Guarded command execution for inspection, build, and test tasks.",
    },
    {
      value: "strict",
      name: "strict",
      description: "Specialized read-only tools only, with command execution disabled.",
    },
    {
      value: null,
      name: MODE_PICKER_EXIT_LABEL,
      description: "Return to chat without changing the current mode.",
    },
  ]);
});

test("mode picker swaps the current marker when strict mode is active", () => {
  const choices = buildModePickerChoices("strict");

  assert.equal(choices[0]?.name, "default");
  assert.equal(choices[1]?.name, "strict (current)");
});
