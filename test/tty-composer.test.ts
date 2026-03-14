import assert from "node:assert/strict";
import test from "node:test";
import {
  applySelectedComposerSuggestion,
  createComposerState,
  insertComposerText,
  submitComposer,
} from "../src/ui/composer-state.js";

const workspaceFiles = [
  "src/agent/loop.ts",
  "src/cli.ts",
  "src/ui/tui.ts",
];

test("composer blocks submit when an @token has matches but is not resolved to one file", () => {
  let state = createComposerState();
  state = insertComposerText(state, "@loop", workspaceFiles);

  const result = submitComposer(state, workspaceFiles);
  assert.equal(result.submittedText, null);
  assert.equal(result.state.buffer, "@loop");
  assert.match(
    result.state.errorMessage ?? "",
    /Resolve file reference "@loop" before sending\./,
  );
});

test("composer treats @@ as a literal @ and allows submit", () => {
  let state = createComposerState();
  state = insertComposerText(state, "Mention @@loop literally", workspaceFiles);

  const result = submitComposer(state, workspaceFiles);
  assert.equal(result.submittedText, "Mention @loop literally");
  assert.equal(result.state.errorMessage, null);
});

test("composer tab-completes the selected file reference without corrupting surrounding text", () => {
  let state = createComposerState();
  state = insertComposerText(state, "Open @src/cl", workspaceFiles);
  state = applySelectedComposerSuggestion(state, workspaceFiles);

  assert.equal(state.buffer, "Open @src/cli.ts ");
  assert.equal(state.errorMessage, null);
});

test("composer submit accepts a slash-command suggestion before submitting", () => {
  let state = createComposerState();
  state = insertComposerText(state, "/his", workspaceFiles);

  const completion = submitComposer(state, workspaceFiles);
  assert.equal(completion.submittedText, null);
  assert.equal(completion.state.buffer, "/history");
  assert.equal(completion.state.errorMessage, null);

  const submission = submitComposer(completion.state, workspaceFiles);
  assert.equal(submission.submittedText, "/history");
});

test("composer tab-completes slash commands", () => {
  let state = createComposerState();
  state = insertComposerText(state, "/ses", workspaceFiles);
  state = applySelectedComposerSuggestion(state, workspaceFiles);

  assert.equal(state.buffer, "/session");
  assert.equal(state.errorMessage, null);
});
