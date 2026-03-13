import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import test from "node:test";
import { executeAgentTool } from "../src/tools/index.js";
import type { CommandApprovalMode } from "../src/tools/types.js";

function createCommandPolicyContext(mode: CommandApprovalMode) {
  return {
    getMode: () => mode,
    setMode: () => undefined,
  };
}

test("run_command executes a safe workspace command in default mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-command-tool-"));
  const previousCwd = process.cwd();

  try {
    await mkdir(path.join(tempDir, "nested"));
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_1",
          name: "run_command",
          arguments: JSON.stringify({
            command: "node -p \"process.cwd()\"",
            cwd: "nested",
          }),
        },
        "default",
      ),
    ) as {
      ok: boolean;
      cwd?: string;
      exitCode?: number | null;
      stdout?: string;
      timedOut?: boolean;
    };

    assert.equal(result.ok, true);
    assert.equal(result.cwd, "nested");
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, path.join(tempDir, "nested"));
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run_command rejects obviously file-modifying commands", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_2",
        name: "run_command",
        arguments: JSON.stringify({
          command: "echo hi > note.txt",
        }),
      },
      "default",
      {
        commandPolicy: createCommandPolicyContext("ask"),
      },
    ),
  ) as {
    ok: boolean;
    error?: string;
  };

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /requires approval/i);
});

test("run_command respects reject mode before execution", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_4",
        name: "run_command",
        arguments: JSON.stringify({
          command: "node -p \"process.cwd()\"",
        }),
      },
      "default",
      {
        commandPolicy: createCommandPolicyContext("reject"),
      },
    ),
  ) as {
    ok: boolean;
    error?: string;
  };

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /rejected by policy/i);
});

test("run_command lets hooks block execution", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_5",
        name: "run_command",
        arguments: JSON.stringify({
          command: "git status",
        }),
      },
      "default",
      {
        commandPolicy: {
          ...createCommandPolicyContext("allow-all"),
          runHook: async () => ({
            action: "block",
            message: "blocked for audit",
          }),
        },
      },
    ),
  ) as {
    ok: boolean;
    error?: string;
  };

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /blocked for audit/);
});

test("strict mode does not expose run_command", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_3",
        name: "run_command",
        arguments: JSON.stringify({
          command: "node -p \"process.cwd()\"",
        }),
      },
      "strict",
    ),
  ) as {
    ok: boolean;
    error?: string;
  };

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unknown tool for strict mode/);
});
