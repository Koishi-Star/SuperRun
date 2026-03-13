import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
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
