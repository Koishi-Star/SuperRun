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

test("replace_lines updates only the requested line range", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-replace-lines-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "example.ts"),
      ["one", "two", "three", "four"].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_7",
          name: "replace_lines",
          arguments: JSON.stringify({
            path: "example.ts",
            start_line: 2,
            end_line: 3,
            content: "TWO\nTHREE",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
      insertedLineCount?: number;
      totalLines?: number;
    };

    assert.equal(result.ok, true);
    assert.equal(result.insertedLineCount, 2);
    assert.equal(result.totalLines, 4);
    assert.equal(
      await readFile(path.join(tempDir, "example.ts"), "utf8"),
      ["one", "TWO", "THREE", "four"].join("\n"),
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("insert_lines inserts before the requested line and can append at the end", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-insert-lines-"));
  const previousCwd = process.cwd();

  try {
    await writeFile(
      path.join(tempDir, "example.ts"),
      ["one", "three"].join("\n"),
      "utf8",
    );
    process.chdir(tempDir);

    const insertMiddle = JSON.parse(
      await executeAgentTool(
        {
          id: "call_8",
          name: "insert_lines",
          arguments: JSON.stringify({
            path: "example.ts",
            before_line: 2,
            content: "two",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
    };
    assert.equal(insertMiddle.ok, true);

    const appendResult = JSON.parse(
      await executeAgentTool(
        {
          id: "call_9",
          name: "insert_lines",
          arguments: JSON.stringify({
            path: "example.ts",
            before_line: 4,
            content: "four",
          }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
      totalLines?: number;
    };

    assert.equal(appendResult.ok, true);
    assert.equal(appendResult.totalLines, 4);
    assert.equal(
      await readFile(path.join(tempDir, "example.ts"), "utf8"),
      ["one", "two", "three", "four"].join("\n") + "\n",
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list_deleted_files, purge_deleted_file, and empty_delete_area manage the delete area lifecycle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-delete-tools-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "superrun-delete-area-"));
  const previousCwd = process.cwd();
  const previousConfigDir = process.env.SUPERRUN_CONFIG_DIR;

  try {
    process.env.SUPERRUN_CONFIG_DIR = configDir;
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "a.ts"), "a\n", "utf8");
    await writeFile(path.join(tempDir, "src", "b.ts"), "b\n", "utf8");
    process.chdir(tempDir);

    const firstDelete = JSON.parse(
      await executeAgentTool(
        {
          id: "call_10",
          name: "delete_file",
          arguments: JSON.stringify({ path: "src/a.ts" }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as { deletedFileId?: string };

    const secondDelete = JSON.parse(
      await executeAgentTool(
        {
          id: "call_11",
          name: "delete_file",
          arguments: JSON.stringify({ path: "src/b.ts" }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as { deletedFileId?: string };

    const listResult = JSON.parse(
      await executeAgentTool(
        {
          id: "call_12",
          name: "list_deleted_files",
          arguments: "{}",
        },
        "strict",
      ),
    ) as {
      ok: boolean;
      entries?: Array<{ id: string; originalPath: string }>;
      deleteArea?: { fileCount: number };
    };

    assert.equal(listResult.ok, true);
    assert.equal(listResult.deleteArea?.fileCount, 2);
    assert.deepEqual(
      listResult.entries?.map((entry) => entry.originalPath).sort(),
      ["src/a.ts", "src/b.ts"],
    );

    const purgeResult = JSON.parse(
      await executeAgentTool(
        {
          id: "call_13",
          name: "purge_deleted_file",
          arguments: JSON.stringify({ id: firstDelete.deletedFileId }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
      purgedId?: string;
      deleteArea?: { fileCount: number };
    };

    assert.equal(purgeResult.ok, true);
    assert.equal(purgeResult.purgedId, firstDelete.deletedFileId);
    assert.equal(purgeResult.deleteArea?.fileCount, 1);

    const emptyResult = JSON.parse(
      await executeAgentTool(
        {
          id: "call_14",
          name: "empty_delete_area",
          arguments: "{}",
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
        },
      ),
    ) as {
      ok: boolean;
      purgedCount?: number;
      deleteArea?: { fileCount: number };
    };

    assert.equal(emptyResult.ok, true);
    assert.equal(emptyResult.purgedCount, 1);
    assert.equal(emptyResult.deleteArea?.fileCount, 0);
    assert.ok(secondDelete.deletedFileId);
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

test("delete_file rejects files larger than 1 MB and records a warning notice without deleting them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "superrun-large-delete-"));
  const previousCwd = process.cwd();
  const notices: Array<{ level: string; message: string }> = [];

  try {
    await writeFile(
      path.join(tempDir, "large.bin"),
      Buffer.alloc(1_024 * 1_024 + 1, 1),
    );
    process.chdir(tempDir);

    const result = JSON.parse(
      await executeAgentTool(
        {
          id: "call_15",
          name: "delete_file",
          arguments: JSON.stringify({ path: "large.bin" }),
        },
        "default",
        {
          workspaceEditPolicy: createWorkspaceEditPolicyContext("allow-all"),
          notices: {
            addNotice: (notice) => notices.push(notice),
          },
        },
      ),
    ) as {
      ok: boolean;
      error?: string;
    };

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /larger than 1 MB/);
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.message ?? "", /Skipped delete area move for large\.bin/);
    assert.equal(
      (await readFile(path.join(tempDir, "large.bin"))).length,
      1_024 * 1_024 + 1,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
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
