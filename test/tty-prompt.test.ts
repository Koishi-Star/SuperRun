import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { readTTYPrompt, type TTYPromptInput } from "../src/ui/tty-prompt.js";

test("readTTYPrompt resumes the input stream before listening for keys", async () => {
  let keypressListener:
    | ((value: string, key: { name?: string; ctrl?: boolean }) => void)
    | null = null;
  let rawMode = false;
  let resumeCount = 0;

  const input: TTYPromptInput = {
    get isRaw() {
      return rawMode;
    },
    resume: () => {
      resumeCount += 1;
    },
    setRawMode: (mode) => {
      rawMode = mode;
    },
    on: (_event, listener) => {
      keypressListener = listener;
    },
    off: (_event, listener) => {
      if (keypressListener === listener) {
        keypressListener = null;
      }
    },
  };
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  const promptPromise = readTTYPrompt({
    input,
    output,
    promptLabel: "you > ",
    workspaceFiles: [],
  });

  assert.equal(resumeCount, 1);
  assert.equal(rawMode, true);
  keypressListener?.("h", { name: "h" });
  keypressListener?.("", { name: "return" });

  assert.equal(await promptPromise, "h");
  assert.equal(rawMode, false);
});

test("readTTYPrompt keeps the default prompt on a single line without divider chrome", async () => {
  let keypressListener:
    | ((value: string, key: { name?: string; ctrl?: boolean }) => void)
    | null = null;
  let renderedOutput = "";

  const input: TTYPromptInput = {
    isRaw: false,
    resume: () => {},
    setRawMode: () => {},
    on: (_event, listener) => {
      keypressListener = listener;
    },
    off: (_event, listener) => {
      if (keypressListener === listener) {
        keypressListener = null;
      }
    },
  };
  const output = new Writable({
    write(chunk, _encoding, callback) {
      renderedOutput += chunk.toString();
      callback();
    },
  });

  const promptPromise = readTTYPrompt({
    input,
    output,
    promptLabel: "you > ",
    workspaceFiles: [],
  });

  keypressListener?.("/", { name: "/" });
  keypressListener?.("", { name: "return" });

  assert.equal(await promptPromise, "/");
  assert.equal(renderedOutput.includes("\u2500"), false);
});
