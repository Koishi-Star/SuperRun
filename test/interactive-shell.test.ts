import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "ink";
import React from "react";
import { createComposerState } from "../src/ui/composer-state.js";
import { InteractiveShell } from "../src/ui/ink/interactive-shell.js";

function createTranscriptViewport() {
  return {
    followLatest: true,
    scrollOffsetLines: 0,
    pendingBelowLines: 0,
    totalLines: 0,
    viewportHeight: 8,
    maxScrollOffsetLines: 0,
    hiddenAboveLines: 0,
    hiddenBelowLines: 0,
  };
}

test("interactive shell renders history viewer overlays without bare text nodes", () => {
  const output = renderToString(
    React.createElement(InteractiveShell, {
      shellFrame: {
        title: "SuperRun",
        workspaceLines: [],
        statusLines: [],
        noticeLines: [],
        footerLines: [],
        contextMeter: null,
      },
      turns: [],
      prompt: {
        label: {
          kind: "user",
          text: "You",
        },
        state: createComposerState(),
      },
      divider: "-".repeat(40),
      shellHeight: 24,
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
      transcriptViewport: createTranscriptViewport(),
      transcriptViewportFallbackHeight: 8,
      onInput: () => {},
      onTranscriptViewportChange: () => {},
    }),
  );

  assert.match(output, /History/);
  assert.match(output, /const value = 1/);
});

test("interactive shell renders unified context indicators across the header and composer", () => {
  const output = renderToString(
    React.createElement(InteractiveShell, {
      shellFrame: {
        title: "SuperRun",
        workspaceLines: [],
        statusLines: [
          {
            id: "status_1",
            kind: "info",
            text: "context  210k / 262.1k  (80.1%)",
            color: "#ff8c42",
          },
          {
            id: "status_2",
            kind: "info",
            text: 'Context nearly full. Consider "/new" to start fresh.',
            color: "redBright",
          },
        ],
        noticeLines: [
          {
            id: "notice_1",
            kind: "warning",
            text: "Delete area now has 1 file (about 55 KB). Use /trash to inspect, restore, purge, or empty it.",
          },
        ],
        footerLines: [],
        contextMeter: {
          usedTokens: 210_000,
          limitTokens: 262_100,
          source: "response",
          modelLabel: "kimi-k2.5",
          display: {
            usedTokens: 210_000,
            limitTokens: 262_100,
            usedText: "210k",
            limitText: "262.1k",
            usageText: "210k/262.1k",
            percentText: "80.1%",
            ratio: 210_000 / 262_100,
            tone: "warning",
            isNearFull: false,
          },
        },
      },
      turns: [],
      prompt: {
        label: {
          kind: "user",
          text: "You",
        },
        state: createComposerState(),
      },
      divider: "─".repeat(60),
      shellHeight: 24,
      inputEnabled: false,
      inputMode: "prompt",
      overlay: null,
      statusText: "Enter submit  Ctrl+C exit",
      commandViewportHeight: 6,
      transcriptViewport: createTranscriptViewport(),
      transcriptViewportFallbackHeight: 8,
      onInput: () => {},
      onTranscriptViewportChange: () => {},
    }),
  );

  assert.match(output, /ctx .*210k\/262\.1k \(80\.1%\)/);
  assert.match(output, /─+ kimi-k2\.5 · ctx 210k\/262\.1k \(80\.1%\) ─+/);
  assert.match(output, /Context nearly full\. Consider "\/new" to/);
  assert.match(output, /start fresh\./);
  assert.match(output, /Delete area now has 1 file \(about 55 KB\)\./);
  assert.match(output, /\n─+\nEnter submit  Ctrl\+C exit/);
});

test("interactive shell keeps a stable transcript viewport height across long output", () => {
  const renderShell = (answerText: string) => renderToString(
    React.createElement(InteractiveShell, {
      shellFrame: {
        title: "SuperRun",
        workspaceLines: [],
        statusLines: [],
        noticeLines: [],
        footerLines: [],
        contextMeter: null,
      },
      turns: [
        {
          id: "turn_1",
          kind: "agent",
          status: "streaming_answer",
          promptText: "Explain the viewport architecture",
          steps: [],
          answerText,
          inlineBlock: null,
        },
      ],
      prompt: {
        label: {
          kind: "user",
          text: "> ",
        },
        state: createComposerState(),
      },
      divider: "-".repeat(60),
      shellHeight: 24,
      inputEnabled: false,
      inputMode: "inactive",
      overlay: null,
      statusText: "Agent is working",
      commandViewportHeight: 6,
      transcriptViewport: createTranscriptViewport(),
      transcriptViewportFallbackHeight: 8,
      onInput: () => {},
      onTranscriptViewportChange: () => {},
    }),
  );

  const shortOutput = renderShell("short answer");
  const longOutput = renderShell(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"));

  assert.equal(shortOutput.split("\n").length, longOutput.split("\n").length);
  assert.match(longOutput, /\^ \d+ earlier lines|v \d+ newer lines/);
});

test("interactive shell preserves transcript rich text formatting inside the viewport", () => {
  const output = renderToString(
    React.createElement(InteractiveShell, {
      shellFrame: {
        title: "SuperRun",
        workspaceLines: [],
        statusLines: [],
        noticeLines: [],
        footerLines: [],
        contextMeter: null,
      },
      turns: [
        {
          id: "turn_1",
          kind: "agent",
          status: "completed",
          promptText: "show markdown",
          steps: [],
          answerText: "Before **bold** `code`\n```py\nprint(1)\n```\nAfter",
          inlineBlock: null,
        },
      ],
      prompt: {
        label: {
          kind: "user",
          text: "> ",
        },
        state: createComposerState(),
      },
      divider: "-".repeat(60),
      shellHeight: 24,
      inputEnabled: false,
      inputMode: "inactive",
      overlay: null,
      statusText: "Agent is working",
      commandViewportHeight: 6,
      transcriptViewport: createTranscriptViewport(),
      transcriptViewportFallbackHeight: 8,
      onInput: () => {},
      onTranscriptViewportChange: () => {},
    }),
  );

  assert.match(output, /bold/);
  assert.match(output, /code/);
  assert.match(output, /\| print\(1\)/);
  assert.doesNotMatch(output, /\*\*bold\*\*/);
  assert.doesNotMatch(output, /`code`/);
});
