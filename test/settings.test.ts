import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import {
  loadSettings,
  resetSystemPrompt,
  saveActiveProvider,
  saveProviderBaseURL,
  saveProviderContextLimitTokens,
  saveProviderModel,
  saveSystemPrompt,
} from "../src/config/settings.js";
import { ALTERNATE_KIMI_BASE_URL } from "../src/llm/provider.js";
import { DEFAULT_SYSTEM_PROMPT } from "../src/prompts/system.js";

test("loadSettings falls back to the built-in prompt when no file exists", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-settings-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    const settings = await loadSettings();
    assert.equal(settings.systemPrompt, DEFAULT_SYSTEM_PROMPT);
    assert.equal(settings.hasStoredSystemPrompt, false);
    assert.equal(settings.providerSettings.activeProvider, "openai_compatible");
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

test("provider settings persist independently from the stored system prompt", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-settings-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    await saveActiveProvider("kimi");
    await saveProviderModel("kimi", "kimi-test-model");
    await saveSystemPrompt("You are a careful reviewer.");

    const afterSave = await loadSettings();
    assert.equal(afterSave.providerSettings.activeProvider, "kimi");
    assert.equal(afterSave.providerSettings.kimi.model, "kimi-test-model");
    assert.equal(afterSave.systemPrompt, "You are a careful reviewer.");

    const afterReset = await resetSystemPrompt();
    assert.equal(afterReset.systemPrompt, DEFAULT_SYSTEM_PROMPT);
    assert.equal(afterReset.providerSettings.activeProvider, "kimi");
    assert.equal(afterReset.providerSettings.kimi.model, "kimi-test-model");

    const content = await readFile(afterReset.filePath, "utf8");
    assert.doesNotMatch(content, /careful reviewer/);
    assert.match(content, /"activeProvider": "kimi"/);
  } finally {
    restoreConfigDir(previousConfigDir);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("saveProviderBaseURL normalizes the Kimi Moonshot domain switch aliases", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-settings-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    await saveActiveProvider("kimi");
    const saved = await saveProviderBaseURL("kimi", "https://api.moonshot.ai");

    assert.equal(saved.providerSettings.kimi.baseURL, ALTERNATE_KIMI_BASE_URL);

    const reloaded = await loadSettings();
    assert.equal(reloaded.providerSettings.kimi.baseURL, ALTERNATE_KIMI_BASE_URL);
  } finally {
    restoreConfigDir(previousConfigDir);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("saveProviderContextLimitTokens persists and clears provider context limits", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-settings-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    await saveActiveProvider("kimi");
    const saved = await saveProviderContextLimitTokens("kimi", 128_000);
    assert.equal(saved.providerSettings.kimi.contextLimitTokens, 128_000);

    const reloaded = await loadSettings();
    assert.equal(reloaded.providerSettings.kimi.contextLimitTokens, 128_000);

    const cleared = await saveProviderContextLimitTokens("kimi", null);
    assert.equal(cleared.providerSettings.kimi.contextLimitTokens, undefined);
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
