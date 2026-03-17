import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { executeAgentTool } from "../src/tools/index.js";
import type { CommandApprovalMode, ToolTurnEvent, WorkspaceEditReviewEvent } from "../src/tools/types.js";

function createWorkspaceEditPolicyContext(mode: CommandApprovalMode) {
  return {
    getMode: () => mode,
    setMode: () => undefined,
  };
}

const SAMPLE_FILE = [
  'import { foo } from "./foo.js";',
  "",
  "export function alpha() {",
  "  return 1;",
  "}",
  "",
  "export function beta() {",
  "  return 2;",
  "}",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// insert_after_symbol
// ---------------------------------------------------------------------------

test("insert_after_symbol inserts code after the anchor symbol", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-ins-"));
  const prev = process.cwd();
  const turnEvents: ToolTurnEvent[] = [];

  try {
    await writeFile(path.join(tempDir, "demo.ts"), SAMPLE_FILE, "utf8");
    process.chdir(tempDir);

    // Get the hash of "alpha".
    const sourceResult = JSON.parse(
      await executeAgentTool(
        {
          id: "c1",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "alpha" }),
        },
        "default",
      ),
    );
    assert.equal(sourceResult.ok, true);
    const hash = sourceResult.bodyHash as string;

    // Insert a new function after alpha.
    const insertResult = JSON.parse(
      await executeAgentTool(
        {
          id: "c2",
          name: "insert_after_symbol",
          arguments: JSON.stringify({
            path: "demo.ts",
            symbol: "alpha",
            expected_hash: hash,
            content: "export function gamma() {\n  return 3;\n}",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
          turnEvents: { addEvent: (e) => turnEvents.push(e) },
        },
      ),
    );

    assert.equal(insertResult.ok, true);
    assert.equal(insertResult.anchorSymbol, "alpha");
    assert.ok(insertResult.insertedLineCount >= 3);

    // Verify file: gamma should appear between alpha and beta.
    const after = await readFile(path.join(tempDir, "demo.ts"), "utf8");
    const alphaPos = after.indexOf("function alpha");
    const gammaPos = after.indexOf("function gamma");
    const betaPos = after.indexOf("function beta");
    assert.ok(alphaPos < gammaPos, "gamma should be after alpha");
    assert.ok(gammaPos < betaPos, "gamma should be before beta");

    // Turn event recorded.
    assert.equal(turnEvents.length, 1);
    assert.equal(turnEvents[0]?.kind, "workspace_edit_review");
    assert.equal((turnEvents[0] as WorkspaceEditReviewEvent | undefined)?.tool, "insert_after_symbol");
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// insert_before_symbol
// ---------------------------------------------------------------------------

test("insert_before_symbol inserts code before the anchor symbol", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-ins-"));
  const prev = process.cwd();
  const turnEvents: ToolTurnEvent[] = [];

  try {
    await writeFile(path.join(tempDir, "demo.ts"), SAMPLE_FILE, "utf8");
    process.chdir(tempDir);

    // Get hash of "beta".
    const sourceResult = JSON.parse(
      await executeAgentTool(
        {
          id: "c3",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "beta" }),
        },
        "default",
      ),
    );
    assert.equal(sourceResult.ok, true);
    const hash = sourceResult.bodyHash as string;

    // Insert before beta.
    const insertResult = JSON.parse(
      await executeAgentTool(
        {
          id: "c4",
          name: "insert_before_symbol",
          arguments: JSON.stringify({
            path: "demo.ts",
            symbol: "beta",
            expected_hash: hash,
            content: "export const SEPARATOR = \"---\";",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
          turnEvents: { addEvent: (e) => turnEvents.push(e) },
        },
      ),
    );

    assert.equal(insertResult.ok, true);
    assert.equal(insertResult.anchorSymbol, "beta");

    // Verify ordering: alpha < SEPARATOR < beta.
    const after = await readFile(path.join(tempDir, "demo.ts"), "utf8");
    const alphaPos = after.indexOf("function alpha");
    const sepPos = after.indexOf("SEPARATOR");
    const betaPos = after.indexOf("function beta");
    assert.ok(alphaPos < sepPos, "SEPARATOR should be after alpha");
    assert.ok(sepPos < betaPos, "SEPARATOR should be before beta");

    assert.equal(turnEvents.length, 1);
    assert.equal(turnEvents[0]?.kind, "workspace_edit_review");
    assert.equal((turnEvents[0] as WorkspaceEditReviewEvent | undefined)?.tool, "insert_before_symbol");
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hash mismatch
// ---------------------------------------------------------------------------

test("insert_after_symbol rejects stale hash", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-ins-"));
  const prev = process.cwd();

  try {
    await writeFile(path.join(tempDir, "demo.ts"), SAMPLE_FILE, "utf8");
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "c5",
          name: "insert_after_symbol",
          arguments: JSON.stringify({
            path: "demo.ts",
            symbol: "alpha",
            expected_hash: "deadbeef",
            content: "export const X = 1;",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    );

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("does not match"));
    assert.ok(result.currentHash);
    assert.ok(result.currentSource);
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Missing symbol
// ---------------------------------------------------------------------------

test("insert_before_symbol rejects missing symbol", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-ins-"));
  const prev = process.cwd();

  try {
    await writeFile(path.join(tempDir, "demo.ts"), SAMPLE_FILE, "utf8");
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "c6",
          name: "insert_before_symbol",
          arguments: JSON.stringify({
            path: "demo.ts",
            symbol: "nonexistent",
            expected_hash: "abcdef01",
            content: "export const X = 1;",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    );

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("not found"));
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Non-TS file rejection
// ---------------------------------------------------------------------------

test("insert_after_symbol rejects non-TS files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-ins-"));
  const prev = process.cwd();

  try {
    await writeFile(path.join(tempDir, "readme.md"), "# Hello\n", "utf8");
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "c7",
          name: "insert_after_symbol",
          arguments: JSON.stringify({
            path: "readme.md",
            symbol: "alpha",
            expected_hash: "12345678",
            content: "new content",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    );

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("TypeScript and JavaScript"));
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Existing symbols preserved
// ---------------------------------------------------------------------------

test("insert_after_symbol preserves existing symbols unchanged", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-ins-"));
  const prev = process.cwd();

  try {
    await writeFile(path.join(tempDir, "demo.ts"), SAMPLE_FILE, "utf8");
    process.chdir(tempDir);

    // Get hashes for both existing symbols.
    const alphaRes = JSON.parse(
      await executeAgentTool(
        {
          id: "c8a",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "alpha" }),
        },
        "default",
      ),
    );
    const betaRes = JSON.parse(
      await executeAgentTool(
        {
          id: "c8b",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "beta" }),
        },
        "default",
      ),
    );

    // Insert after alpha.
    await executeAgentTool(
      {
        id: "c8c",
        name: "insert_after_symbol",
        arguments: JSON.stringify({
          path: "demo.ts",
          symbol: "alpha",
          expected_hash: alphaRes.bodyHash,
          content: "export function gamma() { return 3; }",
        }),
      },
      "default",
      {
        workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
      },
    );

    // Verify alpha and beta still have the same source content.
    const alphaAfter = JSON.parse(
      await executeAgentTool(
        {
          id: "c8d",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "alpha" }),
        },
        "default",
      ),
    );
    const betaAfter = JSON.parse(
      await executeAgentTool(
        {
          id: "c8e",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "beta" }),
        },
        "default",
      ),
    );

    assert.equal(alphaAfter.bodyHash, alphaRes.bodyHash, "alpha hash should be unchanged");
    assert.equal(betaAfter.bodyHash, betaRes.bodyHash, "beta hash should be unchanged");

    // And gamma should now exist.
    const gammaRes = JSON.parse(
      await executeAgentTool(
        {
          id: "c8f",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "gamma" }),
        },
        "default",
      ),
    );
    assert.equal(gammaRes.ok, true);
    assert.equal(gammaRes.name, "gamma");
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});
