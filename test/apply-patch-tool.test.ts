import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { executeAgentTool } from "../src/tools/index.js";
import type { CommandApprovalMode, ToolTurnEvent } from "../src/tools/types.js";

function createWorkspaceEditPolicyContext(mode: CommandApprovalMode) {
  return {
    getMode: () => mode,
    setMode: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Basic single-hunk patch
// ---------------------------------------------------------------------------

test("apply_patch replaces lines matching context in a single hunk", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-apply-patch-"));
  const previousCwd = process.cwd();
  const turnEvents: ToolTurnEvent[] = [];

  try {
    await writeFile(
      path.join(tempDir, "example.ts"),
      ["line1", "line2", "line3", "line4"].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    const patch = [
      "*** Begin Patch",
      "*** Update File: example.ts",
      "@@",
      " line1",
      "-line2",
      "-line3",
      "+LINE2_NEW",
      "+LINE3_NEW",
      " line4",
      "*** End Patch",
    ].join("\n");

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_1",
          name: "apply_patch",
          arguments: JSON.stringify({ patch }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
          turnEvents: {
            addEvent: (event) => turnEvents.push(event),
          },
        },
      ),
    ) as { ok: boolean; files?: Array<{ path: string; hunksApplied: number }> };

    assert.equal(result.ok, true);
    assert.equal(result.files?.length, 1);
    assert.equal(result.files![0]!.hunksApplied, 1);

    const content = await readFile(path.join(tempDir, "example.ts"), "utf8");
    assert.equal(content, ["line1", "LINE2_NEW", "LINE3_NEW", "line4"].join("\n"));

    // Should have a turn event.
    assert.equal(turnEvents.length, 1);
    assert.equal(turnEvents[0]?.kind, "workspace_edit_review");
    assert.equal(turnEvents[0]?.tool, "apply_patch");
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multiple hunks in one file
// ---------------------------------------------------------------------------

test("apply_patch applies multiple hunks in order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-apply-patch-multi-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "multi.ts"),
      ["aaa", "bbb", "ccc", "ddd", "eee"].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    const patch = [
      "*** Begin Patch",
      "*** Update File: multi.ts",
      "@@",
      " aaa",
      "-bbb",
      "+BBB",
      " ccc",
      "@@",
      " ddd",
      "-eee",
      "+EEE",
      "*** End Patch",
    ].join("\n");

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_2",
          name: "apply_patch",
          arguments: JSON.stringify({ patch }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as { ok: boolean; files?: Array<{ hunksApplied: number }> };

    assert.equal(result.ok, true);
    assert.equal(result.files![0]!.hunksApplied, 2);

    const content = await readFile(path.join(tempDir, "multi.ts"), "utf8");
    assert.equal(content, ["aaa", "BBB", "ccc", "ddd", "EEE"].join("\n"));
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Context mismatch — should fail without modifying the file
// ---------------------------------------------------------------------------

test("apply_patch fails on context mismatch without modifying the file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-apply-patch-fail-"));
  const previousCwd = process.cwd();

  try {
    const originalContent = ["alpha", "beta", "gamma"].join("\n");
    await writeFile(path.join(tempDir, "fail.ts"), originalContent, "utf8");
    process.chdir(tempDir);

    const patch = [
      "*** Begin Patch",
      "*** Update File: fail.ts",
      "@@",
      " alpha",
      "-WRONG_LINE",
      "+replacement",
      " gamma",
      "*** End Patch",
    ].join("\n");

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_3",
          name: "apply_patch",
          arguments: JSON.stringify({ patch }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as { ok: boolean; error?: string };

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.ok(result.error!.includes("context mismatch"));

    // File should be unchanged.
    const content = await readFile(path.join(tempDir, "fail.ts"), "utf8");
    assert.equal(content, originalContent);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure insertion (add-only hunk with no context or removals)
// ---------------------------------------------------------------------------

test("apply_patch handles pure insertion hunk", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-apply-patch-insert-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "insert.ts"),
      ["first", "second"].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    // Pure add at file start (searchStart=0, no old pattern).
    const patch = [
      "*** Begin Patch",
      "*** Update File: insert.ts",
      "@@",
      "+zeroth",
      " first",
      " second",
      "*** End Patch",
    ].join("\n");

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_4",
          name: "apply_patch",
          arguments: JSON.stringify({ patch }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as { ok: boolean };

    assert.equal(result.ok, true);

    const content = await readFile(path.join(tempDir, "insert.ts"), "utf8");
    assert.equal(content, ["zeroth", "first", "second"].join("\n"));
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Approval required when policy is "ask"
// ---------------------------------------------------------------------------

test("apply_patch requires approval when edit policy is ask", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-apply-patch-ask-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(path.join(tempDir, "ask.ts"), "line1\nline2\n", "utf8");
    process.chdir(tempDir);

    const patch = [
      "*** Begin Patch",
      "*** Update File: ask.ts",
      "@@",
      "-line1",
      "+LINE1",
      " line2",
      "*** End Patch",
    ].join("\n");

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_5",
          name: "apply_patch",
          arguments: JSON.stringify({ patch }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("ask"),
        },
      ),
    ) as { ok: boolean; error?: string };

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.ok(result.error!.includes("requires approval") || result.error!.includes("Approval"));
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Invalid patch format
// ---------------------------------------------------------------------------

test("apply_patch returns error for invalid patch format", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_6",
        name: "apply_patch",
        arguments: JSON.stringify({ patch: "this is not a patch" }),
      },
      "default",
      {
        workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
      },
    ),
  ) as { ok: boolean; error?: string };

  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.ok(result.error!.includes("Could not parse"));
});
