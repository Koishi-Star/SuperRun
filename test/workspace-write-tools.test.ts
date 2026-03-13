import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { executeAgentTool } from "../src/tools/index.js";
import type { CommandApprovalMode } from "../src/tools/types.js";

function createWorkspaceEditPolicyContext(mode: CommandApprovalMode) {
  return {
    getMode: () => mode,
    setMode: () => undefined,
  };
}

test("write_file creates a new workspace file when approvals allow it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-write-file-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_1",
          name: "write_file",
          arguments: JSON.stringify({
            path: "src/example.ts",
            content: "export const value = 1;\n",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
      path?: string;
      created?: boolean;
      overwritten?: boolean;
      bytesWritten?: number;
    };

    assert.equal(result.ok, true);
    assert.equal(result.path, "src/example.ts");
    assert.equal(result.created, true);
    assert.equal(result.overwritten, false);
    assert.equal(result.bytesWritten, Buffer.byteLength("export const value = 1;\n", "utf8"));
    assert.equal(
      await readFile(path.join(tempDir, "src", "example.ts"), "utf8"),
      "export const value = 1;\n",
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("write_file refuses to overwrite an existing file without overwrite=true", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-write-file-"));
  const previousCwd = process.cwd();

  try {
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "example.ts"), "old\n", "utf8");
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_2",
          name: "write_file",
          arguments: JSON.stringify({
            path: "src/example.ts",
            content: "new\n",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
      error?: string;
    };

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /overwrite=true/);
    assert.equal(
      await readFile(path.join(tempDir, "src", "example.ts"), "utf8"),
      "old\n",
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("write_file requires approval when edit approvals are ask without a prompt handler", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_3",
        name: "write_file",
        arguments: JSON.stringify({
          path: "note.txt",
          content: "hello\n",
        }),
      },
      "default",
      {
        workspaceEditPolicy: createWorkspaceEditPolicyContext("ask"),
      },
    ),
  ) as {
    ok: boolean;
    error?: string;
  };

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /requires approval/i);
});

test("delete_file moves a file into the delete area and restore_deleted_file recovers it with a -recover suffix on collision", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-delete-file-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "superrun-delete-area-"));
  const previousCwd = process.cwd();
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;

  try {
    process.env.SUPERRUN_CONFIG_DIR = configDir;
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "example.ts"), "original\n", "utf8");
    process.chdir(tempDir);

    const deleteResult = JSON.parse(
      await executeAgentTool(
        {
          id: "call_4",
          name: "delete_file",
          arguments: JSON.stringify({
            path: "src/example.ts",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
      deletedFileId?: string;
      deleteArea?: {
        fileCount: number;
        totalBytes: number;
      };
    };

    assert.equal(deleteResult.ok, true);
    assert.equal(deleteResult.deleteArea?.fileCount, 1);

    await writeFile(path.join(tempDir, "src", "example.ts"), "replacement\n", "utf8");

    const restoreResult = JSON.parse(
      await executeAgentTool(
        {
          id: "call_5",
          name: "restore_deleted_file",
          arguments: JSON.stringify({
            id: deleteResult.deletedFileId,
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
      restoredPath?: string;
      originalPath?: string;
      deleteArea?: {
        fileCount: number;
        totalBytes: number;
      };
    };

    assert.equal(restoreResult.ok, true);
    assert.equal(restoreResult.originalPath, "src/example.ts");
    assert.equal(restoreResult.restoredPath, "src/example-recover.ts");
    assert.equal(restoreResult.deleteArea?.fileCount, 0);
    assert.equal(
      await readFile(path.join(tempDir, "src", "example.ts"), "utf8"),
      "replacement\n",
    );
    assert.equal(
      await readFile(path.join(tempDir, "src", "example-recover.ts"), "utf8"),
      "original\n",
    );
  } finally {
    process.chdir(previousCwd);
    if (previousConfigDir === undefined) {
      delete process.env.SUPERRUN_CONFIG_DIR;
    } else {
      process.env.SUPERRUN_CONFIG_DIR = previousConfigDir;
    }
    await rm(tempDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("strict mode does not expose write_file", async () => {
  const result = JSON.parse(
    await executeAgentTool(
      {
        id: "call_6",
        name: "write_file",
        arguments: JSON.stringify({
          path: "note.txt",
          content: "hello\n",
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
