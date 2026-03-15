import assert from "node:assert/strict";
import test from "node:test";
import type { DeletedFileEntry } from "../src/tools/trash.js";
import {
  TRASH_ACTION_EXIT_LABEL,
  TRASH_ENTRY_BACK_LABEL,
  buildTrashActionChoices,
  buildTrashEntryChoices,
} from "../src/ui/trash-picker.js";

function createTrashEntry(index: number): DeletedFileEntry {
  return {
    id: `trash_${index}`,
    originalPath: `src/file-${index}.ts`,
    deletedAt: `2026-03-15T0${index}:00:00.000Z`,
    sizeBytes: 1024 * index,
    storedFileName: `stored-${index}.ts`,
  };
}

test("trash action choices expose interactive restore and delete actions when files exist", () => {
  const choices = buildTrashActionChoices(2);

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["view", "restore", "purge", "empty", null],
  );
  assert.equal(choices.at(-1)?.name, TRASH_ACTION_EXIT_LABEL);
});

test("trash action choices collapse to view and exit when the delete area is empty", () => {
  const choices = buildTrashActionChoices(0);

  assert.deepEqual(choices, [
    {
      value: "view",
      name: "View deleted files",
      description: "The delete area is currently empty.",
      tone: "default",
    },
    {
      value: null,
      name: TRASH_ACTION_EXIT_LABEL,
      description: "Return to chat without changing the delete area.",
      tone: "default",
    },
  ]);
});

test("trash entry choices include a back option and format metadata for restore", () => {
  const choices = buildTrashEntryChoices([createTrashEntry(1)], "restore");

  assert.deepEqual(choices[0], {
    value: "trash_1",
    name: "Restore: src/file-1.ts",
    description: "2026-03-15 01:00 | 1 KB | trash_1",
    tone: "accent",
  });
  assert.deepEqual(choices[1], {
    value: null,
    name: TRASH_ENTRY_BACK_LABEL,
    description: "Return to the delete area action list.",
    tone: "default",
  });
});
