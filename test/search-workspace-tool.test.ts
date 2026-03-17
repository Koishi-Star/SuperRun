import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { executeAgentTool, getAgentToolDefinitions } from "../src/tools/index.js";

test("default and strict modes expose search_workspace", () => {
  assert.equal(
    getAgentToolDefinitions("default").some((tool) => tool.name === "search_workspace"),
    true,
  );
  assert.equal(
    getAgentToolDefinitions("strict").some((tool) => tool.name === "search_workspace"),
    true,
  );
});

test("search_workspace finds matching lines without shelling out", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-search-tool-"));
  const previousCwd = process.cwd();

  try {
    await mkdir(path.join(tempDir, "src"));
    await writeFile(
      path.join(tempDir, "src", "alpha.ts"),
      "export const greeting = 'ciallo';\nexport const subject = 'world';\n",
      "utf8",
    );
    await writeFile(
      path.join(tempDir, "src", "beta.ts"),
      "export function sayHello() {\n  return greeting;\n}\n",
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_1",
          name: "search_workspace",
          arguments: JSON.stringify({
            path: "src",
            pattern: "ciallo",
          }),
        },
        "strict",
      ),
    ) as {
      ok: boolean;
      searchedFiles?: number;
      matches?: Array<{ path: string; line: number; text: string }>;
    };

    assert.equal(result.ok, true);
    assert.equal(result.searchedFiles, 2);
    assert.deepEqual(result.matches, [
      {
        path: "src/alpha.ts",
        line: 1,
        text: "export const greeting = 'ciallo';",
      },
    ]);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});
