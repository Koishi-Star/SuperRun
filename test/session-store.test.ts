import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  createSession,
  deleteSession,
  loadSession,
  loadSessionStore,
  saveSession,
  setActiveSession,
} from "../src/session/store.js";

test("createSession persists a session and marks it active", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-session-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    const created = await createSession({
      systemPrompt: "You are a reviewer.",
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      maxHistoryTurns: 10,
    });

    assert.match(created.session.id, /^s_/);
    assert.equal(created.session.title, "Hi");
    assert.equal(created.session.preview, "Assistant: Hello");
    assert.equal(created.store.activeSessionId, created.session.id);
    assert.equal(created.store.sessions.length, 1);
    assert.equal(created.store.sessions[0]?.title, "Hi");
    assert.equal(created.store.sessions[0]?.preview, "Assistant: Hello");
    assert.equal(created.store.sessions[0]?.turnCount, 1);
    assert.equal(created.store.sessions[0]?.charCount, 7);

    const loaded = await loadSession(created.session.id);
    assert.equal(loaded.title, "Hi");
    assert.equal(loaded.preview, "Assistant: Hello");
    assert.equal(loaded.systemPrompt, "You are a reviewer.");
    assert.deepEqual(loaded.history, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  } finally {
    restoreConfigDir(previousConfigDir);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("saveSession updates an existing session and deleteSession promotes the next active session", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-session-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    const first = await createSession({
      systemPrompt: "You are a reviewer.",
      history: [{ role: "user", content: "First" }],
      maxHistoryTurns: 10,
    });
    const second = await createSession({
      systemPrompt: "You are a reviewer.",
      history: [{ role: "user", content: "Second" }],
      maxHistoryTurns: 10,
    });

    const updated = await saveSession(first.session.id, {
      title: "Ada Session",
      systemPrompt: "You are a reviewer.",
      history: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply" },
      ],
      maxHistoryTurns: 10,
    });
    assert.equal(updated.store.activeSessionId, first.session.id);
    assert.equal(updated.session.title, "Ada Session");

    const preservedTitle = await saveSession(first.session.id, {
      systemPrompt: "You are a reviewer.",
      history: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply again" },
      ],
      maxHistoryTurns: 10,
    });
    assert.equal(preservedTitle.session.title, "Ada Session");

    const switched = await setActiveSession(second.session.id);
    assert.equal(switched.activeSessionId, second.session.id);

    const afterDelete = await deleteSession(second.session.id);
    assert.equal(afterDelete.sessions.length, 1);
    assert.equal(afterDelete.activeSessionId, first.session.id);

    const store = await loadSessionStore();
    assert.equal(store.sessions.length, 1);
    assert.equal(store.activeSessionId, first.session.id);
  } finally {
    restoreConfigDir(previousConfigDir);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadSessionStore hydrates legacy session summaries from stored files", async () => {
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-session-"));
  process.env.SUPERRUN_CONFIG_DIR = tempDir;

  try {
    const sessionsDir = path.join(tempDir, "sessions");
    const sessionId = "s_20260312093622_wf8b1k";
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, `${sessionId}.json`),
      `${JSON.stringify(
        {
          systemPrompt: "You are a reviewer.",
          history: [
            { role: "user", content: "My name is Ada." },
            { role: "assistant", content: "Hello Ada." },
          ],
          maxHistoryTurns: 10,
          updatedAt: "2026-03-12T09:36:22.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(sessionsDir, "index.json"),
      `${JSON.stringify(
        {
          activeSessionId: sessionId,
          sessions: [
            {
              id: sessionId,
              updatedAt: "2026-03-12T09:36:22.000Z",
              turnCount: 1,
              charCount: 25,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const store = await loadSessionStore();
    assert.equal(store.sessions[0]?.title, "My name is Ada.");
    assert.equal(store.sessions[0]?.preview, "Assistant: Hello Ada.");
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
