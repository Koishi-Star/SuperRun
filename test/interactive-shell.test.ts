import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "ink";
import React from "react";
import { createComposerState } from "../src/ui/composer-state.js";
import { InteractiveShell } from "../src/ui/ink/interactive-shell.js";

test("interactive shell renders history viewer overlays without bare text nodes", () => {
  const output = renderToString(
    React.createElement(InteractiveShell, {
      headerLines: [],
      turns: [],
      prompt: {
        label: {
          kind: "user",
          text: "You",
        },
        state: createComposerState(),
      },
      divider: "-".repeat(40),
      inputEnabled: false,
      inputMode: "overlay",
      overlay: {
        kind: "viewer",
        title: "History",
        subtitle: "Current session",
        helpText: null,
        emptyMessage: null,
        scrollOffset: 0,
        viewportHeight: 6,
        lines: [
          { text: "1. You", tone: "info" },
          { text: "## Heading", tone: "info", indent: 3 },
          { text: "```ts", format: "plain", indent: 3 },
          { text: "| const value = 1;", format: "plain", indent: 3 },
          { text: "```", format: "plain", indent: 3 },
          { text: "", indent: 3 },
          { text: "2. Assistant" },
        ],
      },
      statusText: "history 1/20",
      commandViewportHeight: 6,
      onInput: () => {},
    }),
  );

  assert.match(output, /History/);
  assert.match(output, /const value = 1/);
});
