import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPostEditPolicyMessage,
  extractModifiedPaths,
} from "../src/agent/loop.js";
import { createTaskPlan } from "../src/agent/plan.js";

// ---------------------------------------------------------------------------
// extractModifiedPaths
// ---------------------------------------------------------------------------

test("extractModifiedPaths extracts path from standard tool result", () => {
  const result = JSON.stringify({ ok: true, path: "src/example.ts" });
  assert.deepEqual(extractModifiedPaths(result), ["src/example.ts"]);
});

test("extractModifiedPaths extracts paths from apply_patch result", () => {
  const result = JSON.stringify({
    ok: true,
    files: [
      { path: "src/a.ts", hunksApplied: 1 },
      { path: "src/b.ts", hunksApplied: 2 },
    ],
  });
  assert.deepEqual(extractModifiedPaths(result), ["src/a.ts", "src/b.ts"]);
});

test("extractModifiedPaths returns empty for failed tool result", () => {
  const result = JSON.stringify({ ok: false, error: "something went wrong" });
  assert.deepEqual(extractModifiedPaths(result), []);
});

test("extractModifiedPaths returns empty for invalid JSON", () => {
  assert.deepEqual(extractModifiedPaths("not json"), []);
});

// ---------------------------------------------------------------------------
// buildPostEditPolicyMessage — syntax errors
// ---------------------------------------------------------------------------

test("buildPostEditPolicyMessage reports syntax errors for TS files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-post-edit-"));
  const previousCwd = process.cwd();

  try {
    // Write a file with a syntax error.
    await writeFile(
      path.join(tempDir, "broken.ts"),
      "export function greet( { return 'hello'; }",
      "utf8",
    );
    process.chdir(tempDir);

    const toolResult = JSON.stringify({ ok: true, path: "broken.ts" });
    const message = buildPostEditPolicyMessage(toolResult, null);

    assert.ok(message);
    assert.ok(message.includes("Syntax errors detected"));
    assert.ok(message.includes("broken.ts"));
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildPostEditPolicyMessage returns null for clean TS files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-post-edit-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "clean.ts"),
      "export function greet() { return 'hello'; }\n",
      "utf8",
    );
    process.chdir(tempDir);

    const toolResult = JSON.stringify({ ok: true, path: "clean.ts" });
    const message = buildPostEditPolicyMessage(toolResult, null);

    // No syntax errors and no active plan → null.
    assert.equal(message, null);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildPostEditPolicyMessage — step-check reminder
// ---------------------------------------------------------------------------

test("buildPostEditPolicyMessage includes step-check reminder when plan has pending steps", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-post-edit-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "ok.txt"),
      "content\n",
      "utf8",
    );
    process.chdir(tempDir);

    const plan = createTaskPlan({
      title: "Test plan",
      sourcePrompt: "test",
      steps: [
        { title: "Step 1", status: "completed" },
        { title: "Step 2", status: "in_progress" },
        { title: "Step 3" },
      ],
    });

    const toolResult = JSON.stringify({ ok: true, path: "ok.txt" });
    const message = buildPostEditPolicyMessage(toolResult, plan);

    assert.ok(message);
    assert.ok(message.includes("pending plan steps"));
    assert.ok(message.includes("already satisfied"));
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildPostEditPolicyMessage omits step-check when no pending steps", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-post-edit-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "done.txt"),
      "content\n",
      "utf8",
    );
    process.chdir(tempDir);

    const plan = createTaskPlan({
      title: "Test plan",
      sourcePrompt: "test",
      steps: [
        { title: "Step 1", status: "completed" },
        { title: "Step 2", status: "in_progress" },
      ],
    });

    const toolResult = JSON.stringify({ ok: true, path: "done.txt" });
    const message = buildPostEditPolicyMessage(toolResult, plan);

    // No syntax errors (txt file) and no pending steps → null.
    assert.equal(message, null);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildPostEditPolicyMessage — skips non-TS files for syntax check
// ---------------------------------------------------------------------------

test("buildPostEditPolicyMessage skips syntax check for non-TS files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-post-edit-"));
  const previousCwd = process.cwd();

  try {
    // Write invalid content to a non-TS file — should not trigger syntax error.
    await writeFile(
      path.join(tempDir, "broken.json"),
      "{{{invalid json!!!",
      "utf8",
    );
    process.chdir(tempDir);

    const toolResult = JSON.stringify({ ok: true, path: "broken.json" });
    const message = buildPostEditPolicyMessage(toolResult, null);

    assert.equal(message, null);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});
