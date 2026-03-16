import assert from "node:assert/strict";
import test from "node:test";
import { sliceTranscriptOutput } from "../src/ui/transcript-viewport.js";

test("sliceTranscriptOutput pads the transcript window to a fixed height", () => {
  const slice = sliceTranscriptOutput("one\ntwo", 5, 0, true);

  assert.equal(slice.lines.length, 5);
  assert.equal(slice.output.split("\n").length, 5);
  assert.equal(slice.totalLines, 2);
  assert.equal(slice.hiddenAboveLines, 0);
  assert.equal(slice.hiddenBelowLines, 0);
});

test("sliceTranscriptOutput follows the latest lines by default", () => {
  const slice = sliceTranscriptOutput(
    Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
    4,
    0,
    true,
  );

  assert.deepEqual(slice.lines, [
    "^ 8 earlier lines",
    "line 10",
    "line 11",
    "line 12",
  ]);
  assert.equal(slice.scrollOffsetLines, 8);
  assert.equal(slice.maxScrollOffsetLines, 8);
});

test("sliceTranscriptOutput preserves the current window while browsing older transcript lines", () => {
  const initialSlice = sliceTranscriptOutput(
    Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"),
    4,
    2,
    false,
  );

  const nextSlice = sliceTranscriptOutput(
    Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n"),
    4,
    2,
    false,
  );

  assert.deepEqual(initialSlice.lines, [
    "^ 2 earlier lines",
    "line 4",
    "line 5",
    "v 4 newer lines",
  ]);
  assert.deepEqual(nextSlice.lines, [
    "^ 2 earlier lines",
    "line 4",
    "line 5",
    "v 8 newer lines",
  ]);
  assert.equal(nextSlice.scrollOffsetLines, 2);
});

test("sliceTranscriptOutput shows combined hints when the viewport is a single line", () => {
  const slice = sliceTranscriptOutput(
    Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join("\n"),
    1,
    2,
    false,
  );

  assert.deepEqual(slice.lines, ["^ 2  v 3"]);
});
