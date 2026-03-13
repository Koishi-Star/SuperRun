import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFileSuggestion,
  findActiveFileReference,
  getUnresolvedFileReferences,
  matchWorkspaceFiles,
  normalizeFileReferenceEscapes,
} from "../src/ui/file-reference.js";

test("findActiveFileReference detects the @token around the cursor", () => {
  const input = "Explain @src/ui/tt";
  const reference = findActiveFileReference(input, input.length);

  assert.deepEqual(reference, {
    start: 8,
    end: input.length,
    query: "src/ui/tt",
  });
});

test("matchWorkspaceFiles prefers prefix and basename matches", () => {
  const matches = matchWorkspaceFiles(
    [
      "src/ui/tui.ts",
      "src/cli.ts",
      "README.md",
      "test/cli.test.ts",
    ],
    "cli",
  );

  assert.deepEqual(matches, [
    "src/cli.ts",
    "test/cli.test.ts",
  ]);
});

test("applyFileSuggestion replaces the active token with the selected path", () => {
  const input = "Open @src/ui/tt for me";
  const reference = findActiveFileReference(input, 15);

  assert.ok(reference);

  const applied = applyFileSuggestion(input, reference, "src/ui/tui.ts");
  assert.deepEqual(applied, {
    nextInput: "Open @src/ui/tui.ts for me",
    nextCursorIndex: 19,
  });
});

test("applyFileSuggestion appends a trailing space when adjacent text follows", () => {
  const input = "Summarize @src/agent/loopplease";
  const reference = findActiveFileReference(input, input.length);

  assert.ok(reference);

  const applied = applyFileSuggestion(input, reference, "src/agent/loop.ts");
  assert.deepEqual(applied, {
    nextInput: "Summarize @src/agent/loop.ts ",
    nextCursorIndex: 29,
  });
});

test("getUnresolvedFileReferences ignores escaped @@ and returns unresolved tokens", () => {
  const unresolved = getUnresolvedFileReferences(
    "Literal @@loop and missing @loop",
    ["src/agent/loop.ts"],
  );

  assert.deepEqual(unresolved, [
    {
      start: 27,
      end: 32,
      query: "loop",
    },
  ]);
});

test("normalizeFileReferenceEscapes collapses @@ into literal @ characters", () => {
  assert.equal(
    normalizeFileReferenceEscapes("Use @@mention and @@src/cli.ts"),
    "Use @mention and @src/cli.ts",
  );
});
