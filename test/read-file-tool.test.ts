import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { executeAgentTool } from "../src/tools/index.js";

test("read_file reads a bounded line range in strict mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-read-file-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "notes.txt"),
      ["alpha", "beta", "gamma", "delta"].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_1",
          name: "read_file",
          arguments: JSON.stringify({
            path: "notes.txt",
            start_line: 2,
            end_line: 3,
          }),
        },
        "strict",
      ),
    ) as {
      ok: boolean;
      startLine?: number;
      endLine?: number;
      totalLines?: number;
      content?: string;
      truncated?: boolean;
    };

    assert.equal(result.ok, true);
    assert.equal(result.startLine, 2);
    assert.equal(result.endLine, 3);
    assert.equal(result.totalLines, 4);
    assert.equal(result.truncated, true);
    assert.equal(result.content, "beta\ngamma");
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("read_file rejects paths outside the workspace root", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_2",
        name: "read_file",
        arguments: JSON.stringify({
          path: "../outside.txt",
        }),
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
