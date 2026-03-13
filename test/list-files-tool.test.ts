import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { executeAgentTool } from "../src/tools/index.js";

test("list_files lists workspace files with bounded recursion", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-tool-"));
  const previousCwd = process.cwd();

  try {
    await mkdir(path.join(tempDir, "src", "nested"), { recursive: true });
    await writeFile(path.join(tempDir, "README.md"), "hello\n", "utf8");
    await writeFile(path.join(tempDir, "src", "main.ts"), "export {};\n", "utf8");
    await writeFile(path.join(tempDir, "src", "nested", "deep.ts"), "export {};\n", "utf8");
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_1",
          name: "list_files",
          arguments: JSON.stringify({ path: ".", depth: 1 }),
        },
        "strict",
      ),
    ) as {
      ok: boolean;
      entries?: Array<{ path: string; type: string }>;
      truncated?: boolean;
    };

    assert.equal(result.ok, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.entries, [
      { path: "README.md", type: "file" },
      { path: "src", type: "directory" },
      { path: "src/main.ts", type: "file" },
      { path: "src/nested", type: "directory" },
    ]);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list_files rejects paths outside the workspace root", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_2",
        name: "list_files",
        arguments: JSON.stringify({ path: "../outside" }),
      },
      "strict",
    ),
  ) as {
    ok: boolean;
    error?: string;
  };

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /workspace root/);
});
