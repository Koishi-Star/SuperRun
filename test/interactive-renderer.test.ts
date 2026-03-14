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

test("interactive renderer groups system output and agent activity into turn cards", {
  concurrency: false,
}, () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    renderer.setShellFrame([
      { kind: "section", text: "SuperRun" },
      { kind: "info", text: "Local coding agent interactive mode" },
    ]);
    renderer.renderInfo("History restored.");
    renderer.beginAgentTurn("inspect package scripts");
    renderer.applyToolEvent({
      kind: "command_execution",
      phase: "started",
      command: "npm test",
      cwd: ".",
      category: "read",
      summary: "Read-only test command",
    });
    renderer.applyToolEvent({
      kind: "command_execution",
      phase: "output",
      command: "npm test",
      cwd: ".",
      stream: "stdout",
      chunk: "running tests\npass\n",
    });
    renderer.applyToolEvent({
      kind: "workspace_edit_review",
      tool: "write_file",
      path: "note.txt",
      summary: "Create a new file",
      approvalMode: "allow-all",
      autoApproved: true,
      diffPreview: {
        title: "write_file",
        summary: "Create note.txt",
        changeSummary: {
          changedLines: 0,
          addedLines: 1,
          removedLines: 0,
        },
        truncated: false,
        lines: [],
      },
    });
    renderer.appendAssistantChunk("Done.");
    renderer.completeActiveTurn();

    const snapshot = renderer.getSnapshot();
    assert.deepEqual(
      snapshot.headerLines.map((line) => line.text),
      ["SuperRun", "Local coding agent interactive mode"],
    );
    assert.equal(snapshot.turns.length, 2);
    assert.equal(snapshot.turns[0]?.kind, "system");
    assert.equal(snapshot.turns[1]?.kind, "agent");
    if (snapshot.turns[1]?.kind !== "agent") {
      throw new Error("Expected agent turn.");
    }

    assert.equal(snapshot.turns[1].promptText, "inspect package scripts");
    assert.equal(snapshot.turns[1].status, "completed");
    assert.equal(snapshot.turns[1].steps.length, 2);
    assert.equal(snapshot.turns[1].steps[0]?.kind, "command");
    assert.deepEqual(snapshot.turns[1].steps[0]?.outputLines, [
      "stdout | running tests",
      "stdout | pass",
    ]);
    assert.equal(snapshot.turns[1].answerText, "Done.");
  } finally {
    renderer.dispose();
  }
});

test("interactive renderer keeps turn state across suspend resume and clearScreen only clears turns", {
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
    assert.equal(resumedSnapshot.turns.length, 1);
    assert.equal(resumedSnapshot.turns[0]?.kind, "system");
    if (resumedSnapshot.turns[0]?.kind !== "system") {
      throw new Error("Expected system turn.");
    }
    assert.deepEqual(
      resumedSnapshot.turns[0].lines.map((line) => line.text),
      ["Before picker", "After picker"],
    );

    renderer.clearScreen();
    const clearedSnapshot = renderer.getSnapshot();
    assert.equal(clearedSnapshot.turns.length, 0);
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

test("interactive renderer handles backspace and left right cursor movement through semantic input", {
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

test("interactive renderer supports inline approval blocks", {
  concurrency: false,
}, async () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    renderer.beginAgentTurn("run tests");
    const approvalPromise = renderer.requestApproval({
      title: "Approve read command?",
      subtitle: "Read-only test command",
      options: [
        { value: "once", label: "Approve once", description: "Run it now.", tone: "accent" },
        { value: "always", label: "Allow all this session", description: "Switch to allow-all.", tone: "default" },
        { value: "reject", label: "Reject", description: "Block the command.", tone: "danger" },
      ],
    });

    let snapshot = renderer.getSnapshot();
    assert.equal(snapshot.inputMode, "inline");
    assert.equal(snapshot.turns[0]?.kind, "agent");
    if (snapshot.turns[0]?.kind !== "agent" || snapshot.turns[0].inlineBlock?.kind !== "approval") {
      throw new Error("Expected inline approval block.");
    }
    assert.equal(snapshot.turns[0].status, "awaiting_approval");

    renderer.dispatchInput("", createKey({ downArrow: true }));
    renderer.dispatchInput("a", createKey());
    assert.equal(await approvalPromise, "always");

    snapshot = renderer.getSnapshot();
    assert.equal(snapshot.inputMode, "inactive");
    if (snapshot.turns[0]?.kind !== "agent") {
      throw new Error("Expected agent turn.");
    }
    assert.equal(snapshot.turns[0].inlineBlock, null);
    assert.equal(snapshot.turns[0].status, "running_tools");
  } finally {
    renderer.dispose();
  }
});

test("interactive renderer supports inline diff approval blocks", {
  concurrency: false,
}, async () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    renderer.beginAgentTurn("edit file");
    const reviewPromise = renderer.reviewDiff({
      title: "Approve replace_lines?",
      subtitle: "src/example.ts",
      summary: "Replace lines 10-12 in src/example.ts",
      changeSummary: {
        changedLines: 10,
        addedLines: 0,
        removedLines: 0,
      },
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
    if (snapshot.turns[0]?.kind !== "agent" || snapshot.turns[0].inlineBlock?.kind !== "diff") {
      throw new Error("Expected inline diff block.");
    }
    assert.equal(snapshot.turns[0].inlineBlock.scrollOffset, 9);

    renderer.dispatchInput("", createKey({ home: true }));
    snapshot = renderer.getSnapshot();
    if (snapshot.turns[0]?.kind !== "agent" || snapshot.turns[0].inlineBlock?.kind !== "diff") {
      throw new Error("Expected inline diff block.");
    }
    assert.equal(snapshot.turns[0].inlineBlock.scrollOffset, 0);

    renderer.dispatchInput("a", createKey());
    assert.equal(await reviewPromise, "always");
  } finally {
    renderer.dispose();
  }
});

test("interactive renderer supports read only inline diff review blocks", {
  concurrency: false,
}, async () => {
  const input = new FakeTTYInput() as unknown as NodeJS.ReadStream;
  const output = new FakeTTYOutput() as unknown as NodeJS.WriteStream;
  const renderer = createInteractiveRenderer({ input, output, enableInput: false });

  try {
    renderer.beginAgentTurn("apply edit");
    renderer.completeActiveTurn();
    const reviewPromise = renderer.viewDiff({
      title: "Applied replace_lines",
      subtitle: "src/example.ts",
      summary: "Replace lines 10-12 in src/example.ts. changed 2, added 1, removed 0.",
      changeSummary: {
        changedLines: 2,
        addedLines: 1,
        removedLines: 0,
      },
      lines: Array.from({ length: 20 }, (_, index) => ({
        kind: index % 2 === 0 ? "context" : "add",
        oldLineNumber: index % 2 === 0 ? index + 1 : null,
        newLineNumber: index + 1,
        text: `line ${index + 1}`,
      })),
    });

    renderer.dispatchInput("", createKey({ pageDown: true }));
    let snapshot = renderer.getSnapshot();
    if (snapshot.turns[0]?.kind !== "agent" || snapshot.turns[0].inlineBlock?.kind !== "diff") {
      throw new Error("Expected inline diff block.");
    }
    assert.equal(snapshot.turns[0].inlineBlock.mode, "review");
    assert.equal(snapshot.turns[0].inlineBlock.scrollOffset, 8);

    renderer.dispatchInput("", createKey({ escape: true }));
    await reviewPromise;

    snapshot = renderer.getSnapshot();
    if (snapshot.turns[0]?.kind !== "agent") {
      throw new Error("Expected agent turn.");
    }
    assert.equal(snapshot.turns[0].inlineBlock, null);
    assert.equal(snapshot.turns[0].status, "completed");
  } finally {
    renderer.dispose();
  }
});
