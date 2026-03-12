import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/session/store.js";
import {
  createSessionPickerState,
  getSessionPickerViewModel,
  moveSessionPicker,
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

test("session picker view model includes the exit option on every page", () => {
  const sessions = [
    createSessionSummary(1),
    createSessionSummary(2),
    createSessionSummary(3),
    createSessionSummary(4),
  ];

  const firstPage = getSessionPickerViewModel(
    sessions,
    "s_2",
    createSessionPickerState(),
  );

  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.options.length, 4);
  assert.equal(firstPage.options[0]?.kind, "session");
  assert.equal(firstPage.options[1]?.kind, "session");
  assert.equal(firstPage.options[1]?.kind === "session" && firstPage.options[1].isCurrent, true);
  assert.equal(firstPage.options[3]?.kind, "exit");

  const secondPage = getSessionPickerViewModel(
    sessions,
    "s_2",
    {
      pageIndex: 1,
      selectedIndex: 0,
    },
  );

  assert.equal(secondPage.options.length, 2);
  assert.equal(secondPage.options[0]?.kind, "session");
  assert.equal(secondPage.options[0]?.kind === "session" && secondPage.options[0].globalIndex, 4);
  assert.equal(secondPage.options[1]?.kind, "exit");
});

test("session picker moves down across page boundaries", () => {
  const sessions = [
    createSessionSummary(1),
    createSessionSummary(2),
    createSessionSummary(3),
    createSessionSummary(4),
  ];

  const moved = moveSessionPicker(
    {
      pageIndex: 0,
      selectedIndex: 3,
    },
    sessions,
    "down",
  );

  assert.deepEqual(moved, {
    pageIndex: 1,
    selectedIndex: 0,
  });
});

test("session picker moves up across page boundaries", () => {
  const sessions = [
    createSessionSummary(1),
    createSessionSummary(2),
    createSessionSummary(3),
    createSessionSummary(4),
  ];

  const moved = moveSessionPicker(
    {
      pageIndex: 1,
      selectedIndex: 0,
    },
    sessions,
    "up",
  );

  assert.deepEqual(moved, {
    pageIndex: 0,
    selectedIndex: 3,
  });
});

test("session picker clamps the selected row when paging left or right", () => {
  const sessions = [
    createSessionSummary(1),
    createSessionSummary(2),
    createSessionSummary(3),
    createSessionSummary(4),
  ];

  const movedRight = moveSessionPicker(
    {
      pageIndex: 0,
      selectedIndex: 3,
    },
    sessions,
    "right",
  );

  assert.deepEqual(movedRight, {
    pageIndex: 1,
    selectedIndex: 1,
  });

  const movedLeft = moveSessionPicker(
    movedRight,
    sessions,
    "left",
  );

  assert.deepEqual(movedLeft, {
    pageIndex: 0,
    selectedIndex: 1,
  });
});

test("session picker shows only the exit option when no sessions are saved", () => {
  const viewModel = getSessionPickerViewModel(
    [],
    null,
    createSessionPickerState(),
  );

  assert.equal(viewModel.totalPages, 1);
  assert.equal(viewModel.options.length, 1);
  assert.equal(viewModel.options[0]?.kind, "exit");
});
