import assert from "node:assert/strict";
import test from "node:test";
import { getDisplayWidth } from "../src/ui/text-width.js";

test("getDisplayWidth counts ASCII text as single-width", () => {
  assert.equal(getDisplayWidth("abc"), 3);
});

test("getDisplayWidth counts CJK text as double-width", () => {
  assert.equal(getDisplayWidth("\u4f60\u597d"), 4);
  assert.equal(getDisplayWidth(`a\u4f60b`), 4);
});

test("getDisplayWidth ignores ANSI escape sequences", () => {
  assert.equal(getDisplayWidth("\u001B[31mred\u001B[39m"), 3);
});
