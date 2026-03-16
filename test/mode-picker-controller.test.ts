import assert from "node:assert/strict";
import test from "node:test";
import {
  CRAZY_AUTO_MODE_VALUE,
  MODE_PICKER_EXIT_LABEL,
  buildModePickerChoices,
} from "../src/ui/mode-picker.js";

test("mode picker choices mark the active mode and include an exit option", () => {
  const choices = buildModePickerChoices("default", "ask");

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
      value: CRAZY_AUTO_MODE_VALUE,
      name: "crazy-auto",
      description:
        "Default tools plus auto-approved file edits and elevated-risk shell actions.",
    },
    {
      value: null,
      name: MODE_PICKER_EXIT_LABEL,
      description: "Return to chat without changing the current mode.",
    },
  ]);
});

test("mode picker swaps the current marker when strict mode is active", () => {
  const choices = buildModePickerChoices("strict", "ask");

  assert.equal(choices[0]?.name, "default");
  assert.equal(choices[1]?.name, "strict (current)");
});

test("mode picker marks crazy-auto as current when elevated approvals are active", () => {
  const choices = buildModePickerChoices("default", "crazy_auto");

  assert.equal(choices[0]?.name, "default");
  assert.equal(choices[2]?.name, "crazy-auto (current)");
});
