import assert from "node:assert/strict";
import test from "node:test";
import { isPromptExitError } from "../src/ui/inquirer-errors.js";

for (const errorName of [
  "AbortPromptError",
  "CancelPromptError",
  "ExitPromptError",
]) {
  test(`isPromptExitError treats ${errorName} as a non-fatal prompt exit`, () => {
    const error = new Error("prompt closed");
    error.name = errorName;
    assert.equal(isPromptExitError(error), true);
  });
}

test("isPromptExitError ignores unrelated errors", () => {
  assert.equal(isPromptExitError(new Error("boom")), false);
  assert.equal(isPromptExitError("boom"), false);
});
