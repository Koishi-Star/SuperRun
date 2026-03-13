import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Key } from "node:readline";
import test from "node:test";
import { readTTYPrompt } from "../src/ui/tty-prompt.js";

class FakeTTYInput extends EventEmitter {
  isRaw = false;
  rawModeChanges: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModeChanges.push(mode);
  }

  sendKey(name: Key["name"], value = "", options?: Partial<Key>): void {
    this.emit("keypress", value, {
      name,
      ...options,
    } as Key);
  }

  sendText(value: string): void {
    for (const char of value) {
      this.sendKey(char, char);
    }
  }
}

test("readTTYPrompt keeps unresolved @tokens local instead of submitting them", async () => {
  const input = new FakeTTYInput();
  const output = new PassThrough();
  let rendered = "";

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });

  const promptPromise = readTTYPrompt({
    input,
    output,
    promptLabel: "you > ",
    workspaceFiles: ["src/agent/loop.ts"],
  });

  input.sendText("@loop");
  input.sendKey("return");
  await new Promise((resolve) => setTimeout(resolve, 20));

  let resolved = false;
  void promptPromise.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(resolved, false);
  assert.match(rendered, /Resolve file reference "@loop" before sending\./);

  input.sendKey("c", "", { ctrl: true });
  const value = await promptPromise;
  assert.equal(value, "/exit");
  assert.deepEqual(input.rawModeChanges, [true, false]);
});
