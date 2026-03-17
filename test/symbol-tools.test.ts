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
// get_symbols
// ---------------------------------------------------------------------------

test("get_symbols lists symbols in a TS file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "demo.ts"),
      [
        'import { x } from "./x.js";',
        "",
        "export function hello() { return 1; }",
        "",
        "export const SIZE = 42;",
        "",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        { id: "c1", name: "get_symbols", arguments: JSON.stringify({ path: "demo.ts" }) },
        "default",
      ),
    );

    assert.equal(result.ok, true);
    assert.equal(result.path, "demo.ts");
    assert.ok(result.totalLines >= 5);
    const names = (result.symbols as { name: string }[]).map((s) => s.name);
    assert.ok(names.includes("hello"));
    assert.ok(names.includes("SIZE"));
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("get_symbols rejects non-TS files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();

  try {
    await writeFile(path.join(tempDir, "readme.md"), "# Hello\n", "utf8");
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        { id: "c2", name: "get_symbols", arguments: JSON.stringify({ path: "readme.md" }) },
        "default",
      ),
    );

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("TypeScript and JavaScript"));
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("get_symbols works in strict mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "index.ts"),
      "export type Foo = string;\n",
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        { id: "c3", name: "get_symbols", arguments: JSON.stringify({ path: "index.ts" }) },
        "strict",
      ),
    );

    assert.equal(result.ok, true);
    assert.equal(result.symbols.length, 1);
    assert.equal(result.symbols[0].name, "Foo");
    assert.equal(result.symbols[0].kind, "type");
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// get_symbol_source
// ---------------------------------------------------------------------------

test("get_symbol_source returns source with hash and imports", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "demo.ts"),
      [
        'import { bar } from "./bar.js";',
        "",
        "export function greet(name: string) {",
        '  return "Hi " + name;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "c4",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "greet" }),
        },
        "default",
      ),
    );

    assert.equal(result.ok, true);
    assert.equal(result.name, "greet");
    assert.equal(result.kind, "function");
    assert.ok(result.source.includes("function greet"));
    assert.ok(result.bodyHash);
    assert.ok(result.imports.length >= 1);
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("get_symbol_source returns error for missing symbol", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "demo.ts"),
      "export const x = 1;\n",
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "c5",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "missing" }),
        },
        "default",
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
// replace_symbol_body
// ---------------------------------------------------------------------------

test("replace_symbol_body replaces a symbol with correct hash", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();
  const turnEvents: ToolTurnEvent[] = [];

  try {
    await writeFile(
      path.join(tempDir, "demo.ts"),
      [
        "export function greet() {",
        '  return "Hello";',
        "}",
        "",
        "export const SIZE = 42;",
        "",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    // Step 1: Get the current hash.
    const sourceResult = JSON.parse(
      await executeAgentTool(
        {
          id: "c6",
          name: "get_symbol_source",
          arguments: JSON.stringify({ path: "demo.ts", symbol: "greet" }),
        },
        "default",
      ),
    );
    assert.equal(sourceResult.ok, true);
    const hash = sourceResult.bodyHash as string;

    // Step 2: Replace the symbol.
    const replaceResult = JSON.parse(
      await executeAgentTool(
        {
          id: "c7",
          name: "replace_symbol_body",
          arguments: JSON.stringify({
            path: "demo.ts",
            symbol: "greet",
            expected_hash: hash,
            new_body: 'export function greet() {\n  return "Hi";\n}',
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
          turnEvents: { addEvent: (e) => turnEvents.push(e) },
        },
      ),
    );

    assert.equal(replaceResult.ok, true);
    assert.equal(replaceResult.symbol, "greet");
    assert.ok(replaceResult.newHash);
    assert.notEqual(replaceResult.newHash, hash);

    // Step 3: Verify file contents.
    const fileAfter = await readFile(path.join(tempDir, "demo.ts"), "utf8");
    assert.ok(fileAfter.includes('"Hi"'), "file should have the new return value");
    assert.ok(fileAfter.includes("SIZE = 42"), "SIZE should be untouched");
    assert.ok(!fileAfter.includes('"Hello"'), "old return value should be gone");

    // Turn event recorded.
    assert.equal(turnEvents.length, 1);
    assert.equal(turnEvents[0]?.kind, "workspace_edit_review");
    assert.equal(turnEvents[0]?.tool, "replace_symbol_body");
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("replace_symbol_body rejects stale hash", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "demo.ts"),
      "export function greet() { return 1; }\n",
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "c8",
          name: "replace_symbol_body",
          arguments: JSON.stringify({
            path: "demo.ts",
            symbol: "greet",
            expected_hash: "deadbeef",
            new_body: "export function greet() { return 2; }",
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
    assert.ok(result.currentHash, "should include current hash for recovery");
    assert.ok(result.currentSource, "should include current source for recovery");
  } finally {
    process.chdir(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("replace_symbol_body rejects missing symbol", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "demo.ts"),
      "export const x = 1;\n",
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "c9",
          name: "replace_symbol_body",
          arguments: JSON.stringify({
            path: "demo.ts",
            symbol: "missing",
            expected_hash: "abcdef01",
            new_body: "export const missing = 2;",
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

test("replace_symbol_body rejects non-TS files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-sym-"));
  const prev = process.cwd();

  try {
    await writeFile(path.join(tempDir, "readme.md"), "# Hello\n", "utf8");
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "c10",
          name: "replace_symbol_body",
          arguments: JSON.stringify({
            path: "readme.md",
            symbol: "greet",
            expected_hash: "abcdef01",
            new_body: "export function greet() {}",
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
