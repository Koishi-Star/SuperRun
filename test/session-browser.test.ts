import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/session/store.js";
import type {
  InteractiveRenderer,
  RendererSelectOptions,
} from "../src/ui/interactive-renderer.js";
import { runSessionBrowser } from "../src/ui/session-browser.js";
import { SESSION_PICKER_NEW_VALUE } from "../src/ui/session-picker.js";

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

function createRendererStub(script: {
  selections: Array<string | null>;
  prompts?: string[];
}) {
  const selectCalls: RendererSelectOptions[] = [];
  const promptLabels: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const pendingSelections = [...script.selections];
  const pendingPrompts = [...(script.prompts ?? [])];

  const renderer = {
    async selectOption(options: RendererSelectOptions): Promise<string | null> {
      selectCalls.push(options);
      const nextSelection = pendingSelections.shift();
      if (nextSelection === undefined) {
        throw new Error("No scripted selectOption value remaining.");
      }

      return nextSelection;
    },
    async readPrompt(options: {
      promptLabel: string;
      workspaceFiles: string[];
    }): Promise<string> {
      promptLabels.push(options.promptLabel);
      const nextPrompt = pendingPrompts.shift();
      if (nextPrompt === undefined) {
        throw new Error("No scripted prompt value remaining.");
      }

      return nextPrompt;
    },
    renderInfo(message: string): void {
      infos.push(message);
    },
    renderError(message: string): void {
      errors.push(message);
    },
  } satisfies Partial<InteractiveRenderer>;

  return {
    renderer: renderer as InteractiveRenderer,
    selectCalls,
    promptLabels,
    infos,
    errors,
  };
}

test("session browser returns to the session list after /cancel in the new-session prompt", async () => {
  const stub = createRendererStub({
    selections: [
      SESSION_PICKER_NEW_VALUE,
      "s_1",
      "switch",
    ],
    prompts: ["/cancel"],
  });

  const result = await runSessionBrowser(stub.renderer, {
    sessions: [createSessionSummary(1)],
    currentSessionId: null,
  });

  assert.deepEqual(result, {
    kind: "switch",
    sessionId: "s_1",
  });
  assert.deepEqual(stub.promptLabels, ["new (/cancel) > "]);
  assert.deepEqual(
    stub.selectCalls.map((call) => call.title),
    ["Saved Sessions", "Saved Sessions", "Session 1"],
  );
});

test("session browser returns to the action menu after /cancel in rename", async () => {
  const stub = createRendererStub({
    selections: [
      "s_1",
      "rename",
      null,
      null,
    ],
    prompts: ["/cancel"],
  });

  const result = await runSessionBrowser(stub.renderer, {
    sessions: [createSessionSummary(1)],
    currentSessionId: null,
  });

  assert.deepEqual(result, {
    kind: "cancel",
  });
  assert.deepEqual(stub.promptLabels, ["rename (/cancel) > "]);
  assert.deepEqual(
    stub.selectCalls.map((call) => call.title),
    ["Saved Sessions", "Session 1", "Session 1", "Saved Sessions"],
  );
});

test("session browser bubbles /exit from nested prompts", async () => {
  const stub = createRendererStub({
    selections: [SESSION_PICKER_NEW_VALUE],
    prompts: ["/exit"],
  });

  const result = await runSessionBrowser(stub.renderer, {
    sessions: [],
    currentSessionId: null,
  });

  assert.deepEqual(result, {
    kind: "exit",
  });
});
