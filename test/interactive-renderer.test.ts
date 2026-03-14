import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Key } from "ink";
import { createInteractiveRenderer } from "../src/ui/interactive-renderer.js";

class FakeTTYInput extends PassThrough {
  isTTY = true;
  resumeCallCount = 0;

  setRawMode(_mode: boolean): void {}

  override resume(): this {
    this.resumeCallCount += 1;
    return super.resume();
  }
}

class FakeTTYOutput extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
}

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

test("interactive renderer appends log lines and streams assistant chunks into one entry", {
  concurrency: false,
}, async () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    renderer.setShellFrame([
      { kind: "section", text: "SuperRun" },
      { kind: "info", text: "Local coding agent interactive mode" },
    ]);
    renderer.renderInfo("History restored.");
    renderer.renderAssistantPrefix();
    renderer.appendAssistantChunk("Hello");
    renderer.appendAssistantChunk(", world.");

    const snapshot = renderer.getSnapshot();
    assert.deepEqual(
      snapshot.headerLines.map((line) => line.text),
      ["SuperRun", "Local coding agent interactive mode"],
    );
    assert.deepEqual(
      snapshot.logLines.map((line) => ({
        kind: line.kind,
        text: line.text,
      })),
      [
        { kind: "info", text: "History restored." },
        { kind: "assistant", text: "Hello, world." },
      ],
    );
  } finally {
    renderer.dispose();
  }
});

test("interactive renderer keeps state across suspend/resume and clearScreen only clears logs", {
  concurrency: false,
}, () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    renderer.setShellFrame([
      { kind: "section", text: "SuperRun" },
      { kind: "info", text: "Header line" },
    ]);
    renderer.renderInfo("Before picker");

    renderer.suspend();
    renderer.resume();
    renderer.renderInfo("After picker");

    const resumedSnapshot = renderer.getSnapshot();
    assert.deepEqual(
      resumedSnapshot.headerLines.map((line) => line.text),
      ["SuperRun", "Header line"],
    );
    assert.deepEqual(
      resumedSnapshot.logLines.map((line) => line.text),
      ["Before picker", "After picker"],
    );

    renderer.clearScreen();
    const clearedSnapshot = renderer.getSnapshot();
    assert.equal(clearedSnapshot.logLines.length, 0);
    assert.deepEqual(
      clearedSnapshot.headerLines.map((line) => line.text),
      ["SuperRun", "Header line"],
    );
  } finally {
    renderer.dispose();
  }
});

test("interactive renderer switches prompt labels when reading inline editor input", {
  concurrency: false,
}, () => {
  const input = new FakeTTYInput();
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({
    input: input as unknown as NodeJS.ReadStream,
    output,
    enableInput: false,
  });

  try {
    void renderer.readPrompt({
      promptLabel: renderer.editorPromptLabel,
      workspaceFiles: [],
    });

    const snapshot = renderer.getSnapshot();
    assert.equal(input.resumeCallCount, 1);
    assert.equal(snapshot.inputActive, true);
    assert.equal(snapshot.prompt.label.kind, "editor");
    assert.equal(snapshot.prompt.label.text, renderer.editorPromptLabel);
  } finally {
    renderer.dispose();
  }
});

test("interactive renderer handles backspace and left/right cursor movement through semantic input", {
  concurrency: false,
}, async () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    const promptPromise = renderer.readPrompt({
      promptLabel: renderer.promptLabel,
      workspaceFiles: [],
    });

    renderer.dispatchInput("ab", createKey());
    renderer.dispatchInput("", createKey({ leftArrow: true }));
    renderer.dispatchInput("", createKey({ backspace: true }));
    renderer.dispatchInput("", createKey({ rightArrow: true }));

    const snapshot = renderer.getSnapshot();
    assert.equal(snapshot.prompt.state.buffer, "b");
    assert.equal(snapshot.prompt.state.cursorIndex, 1);

    renderer.dispatchInput("", createKey({ return: true }));
    assert.equal(await promptPromise, "b");
  } finally {
    renderer.dispose();
  }
});

test("interactive renderer applies file suggestions with Tab and clears submit errors with Escape", {
  concurrency: false,
}, async () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    const suggestionPrompt = renderer.readPrompt({
      promptLabel: renderer.promptLabel,
      workspaceFiles: ["src/ui/input-events.ts"],
    });

    renderer.dispatchInput("@src/ui/inp", createKey());
    renderer.dispatchInput("", createKey({ tab: true }));

    let snapshot = renderer.getSnapshot();
    assert.equal(snapshot.prompt.state.buffer, "@src/ui/input-events.ts ");
    assert.equal(snapshot.prompt.state.activeReference, null);

    renderer.dispatchInput("", createKey({ return: true }));
    assert.equal(await suggestionPrompt, "@src/ui/input-events.ts ");

    const errorPrompt = renderer.readPrompt({
      promptLabel: renderer.promptLabel,
      workspaceFiles: ["src/ui/input-events.ts"],
    });

    renderer.dispatchInput("@missing", createKey());
    renderer.dispatchInput("", createKey({ return: true }));

    snapshot = renderer.getSnapshot();
    assert.match(snapshot.prompt.state.errorMessage ?? "", /No files match "@missing"\./);

    renderer.dispatchInput("", createKey({ escape: true }));
    snapshot = renderer.getSnapshot();
    assert.equal(snapshot.prompt.state.errorMessage, null);

    renderer.dispatchInput("c", createKey({ ctrl: true }));
    assert.equal(await errorPrompt, "/exit");
  } finally {
    renderer.dispose();
  }
});

test("interactive renderer supports scrollable diff approval overlays", {
  concurrency: false,
}, async () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    const reviewPromise = renderer.reviewDiff({
      title: "Approve replace_lines?",
      subtitle: "src/example.ts",
      summary: "Replace lines 10-12 in src/example.ts",
      lines: Array.from({ length: 30 }, (_, index) => ({
        kind: index % 3 === 0 ? "remove" : index % 3 === 1 ? "add" : "context",
        oldLineNumber: index % 3 === 1 ? null : index + 1,
        newLineNumber: index % 3 === 0 ? null : index + 1,
        text: `line ${index + 1}`,
      })),
    });

    renderer.dispatchInput("", createKey({ downArrow: true }));
    renderer.dispatchInput("", createKey({ pageDown: true }));

    let snapshot = renderer.getSnapshot();
    assert.equal(snapshot.overlay?.kind, "diff");
    assert.equal(snapshot.overlay?.scrollOffset, 11);

    renderer.dispatchInput("", createKey({ home: true }));
    snapshot = renderer.getSnapshot();
    assert.equal(snapshot.overlay?.kind, "diff");
    assert.equal(snapshot.overlay?.scrollOffset, 0);

    renderer.dispatchInput("a", createKey());
    assert.equal(await reviewPromise, "always");
  } finally {
    renderer.dispose();
  }
});
