import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import {
  loadSettings,
  resetSystemPrompt,
  saveSystemPrompt,
} from "../src/config/settings.js";
import { DEFAULT_SYSTEM_PROMPT } from "../src/prompts/system.js";

test("loadSettings falls back to the built-in prompt when no file exists", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-settings-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    const settings = await loadSettings();
    assert.equal(settings.systemPrompt, DEFAULT_SYSTEM_PROMPT);
    assert.equal(settings.hasStoredSystemPrompt, false);
    assert.equal(settings.filePath, path.join(tempDir, "settings.json"));
  } finally {
    restoreConfigDir(previousConfigDir);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("saveSystemPrompt persists the prompt and resetSystemPrompt removes the override", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-settings-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    const saved = await saveSystemPrompt("You are a careful reviewer.");
    assert.equal(saved.systemPrompt, "You are a careful reviewer.");
    assert.equal(saved.hasStoredSystemPrompt, true);

    const content = await readFile(saved.filePath, "utf8");
    assert.match(content, /You are a careful reviewer\./);

    const loaded = await loadSettings();
    assert.equal(loaded.systemPrompt, "You are a careful reviewer.");
    assert.equal(loaded.hasStoredSystemPrompt, true);

    const reset = await resetSystemPrompt();
    assert.equal(reset.systemPrompt, DEFAULT_SYSTEM_PROMPT);
    assert.equal(reset.hasStoredSystemPrompt, false);

    const afterReset = await loadSettings();
    assert.equal(afterReset.systemPrompt, DEFAULT_SYSTEM_PROMPT);
    assert.equal(afterReset.hasStoredSystemPrompt, false);
  } finally {
    restoreConfigDir(previousConfigDir);
    await rm(tempDir, { recursive: true, force: true });
  }
});

function restoreConfigDir(previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env.SUPERRUN_CONFIG_DIR;
    return;
  }

  process.env.SUPERRUN_CONFIG_DIR = previousValue;
}
