import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import {
  clearSavedSession,
  loadSavedSession,
  saveSession,
} from "../src/session/store.js";

test("saveSession persists a session that loadSavedSession can restore", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-session-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    const saved = await saveSession({
      systemPrompt: "You are a reviewer.",
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      maxHistoryTurns: 10,
    });

    assert.equal(saved.systemPrompt, "You are a reviewer.");
    assert.equal(saved.history.length, 2);
    assert.equal(saved.maxHistoryTurns, 10);

    const loaded = await loadSavedSession();
    assert.equal(loaded.filePath, path.join(tempDir, "session.json"));
    assert.equal(loaded.session?.systemPrompt, "You are a reviewer.");
    assert.deepEqual(loaded.session?.history, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
    assert.equal(loaded.session?.maxHistoryTurns, 10);
    assert.match(loaded.session?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    restoreConfigDir(previousConfigDir);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("clearSavedSession removes the persisted session", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-session-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    await saveSession({
      systemPrompt: "You are a reviewer.",
      history: [{ role: "user", content: "Hi" }],
      maxHistoryTurns: 10,
    });

    const filePath = await clearSavedSession();
    assert.equal(filePath, path.join(tempDir, "session.json"));

    const loaded = await loadSavedSession();
    assert.equal(loaded.session, null);
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
