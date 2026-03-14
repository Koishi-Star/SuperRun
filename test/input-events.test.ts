import assert from "node:assert/strict";
import test from "node:test";
import type { Key } from "ink";
import { normalizeInkInput } from "../src/ui/input-events.js";

function createKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

test("normalizeInkInput maps raw backspace bytes to a semantic backspace event", () => {
  assert.deepEqual(
    normalizeInkInput("\b", createKey()),
    { type: "backspace" },
  );
  assert.deepEqual(
    normalizeInkInput("\u007f", createKey()),
    { type: "backspace" },
  );
  assert.deepEqual(
    normalizeInkInput("h", createKey({ ctrl: true })),
    { type: "backspace" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ delete: true })),
    { type: "delete" },
  );
});

test("normalizeInkInput maps Windows delete-at-end to semantic backspace in prompt context", () => {
  assert.deepEqual(
    normalizeInkInput("", createKey({ delete: true }), {
      platform: "win32",
      promptBufferLength: 3,
      promptCursorIndex: 3,
    }),
    { type: "backspace" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ delete: true }), {
      platform: "win32",
      promptBufferLength: 3,
      promptCursorIndex: 1,
    }),
    { type: "delete" },
  );
});

test("normalizeInkInput preserves printable text insertion", () => {
  assert.deepEqual(
    normalizeInkInput("abc", createKey()),
    { type: "insert_text", text: "abc" },
  );
});

test("normalizeInkInput maps navigation and submit keys to semantic events", () => {
  assert.deepEqual(
    normalizeInkInput("", createKey({ upArrow: true })),
    { type: "move_up" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ downArrow: true })),
    { type: "move_down" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ pageUp: true })),
    { type: "move_page_up" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ pageDown: true })),
    { type: "move_page_down" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ return: true })),
    { type: "submit" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ escape: true })),
    { type: "cancel" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ leftArrow: true })),
    { type: "move_left" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ rightArrow: true })),
    { type: "move_right" },
  );
  assert.deepEqual(
    normalizeInkInput("", createKey({ tab: true })),
    { type: "apply_suggestion" },
  );
});
