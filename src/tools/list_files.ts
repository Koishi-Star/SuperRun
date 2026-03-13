import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import type { ToolExecutionContext } from "./types.js";
import {
  normalizeRelativeWorkspacePath,
  resolveWorkspacePath,
} from "./workspace.js";

const MAX_DEPTH = 5;
const MAX_ENTRIES = 200;
const NON_RECURSIVE_DIRECTORIES = new Set([".git", "node_modules"]);

const listFilesArgsSchema = z.object({
  path: z.string().trim().min(1).optional(),
  depth: z.number().int().min(0).max(MAX_DEPTH).optional(),
});

type ListFilesArgs = z.infer<typeof listFilesArgsSchema>;

type ListFilesEntry = {
  path: string;
  type: "file" | "directory" | "symlink";
};

export const listFilesTool = {
  definition: {
    name: "list_files",
    description:
      "List files and directories under a workspace path. Use this to inspect the repository structure before reading file contents.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative workspace path to list. Defaults to the current workspace root.",
        },
        depth: {
          type: "integer",
          description:
            "How many directory levels to recurse below the starting path. Defaults to 2.",
          minimum: 0,
          maximum: MAX_DEPTH,
        },
      },
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    _context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseListFilesArgs(rawArguments);
      const result = await listWorkspaceFiles(parsedArgs);
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown list_files error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

export async function listWorkspaceFiles(args?: ListFilesArgs): Promise<{
  path: string;
  depth: number;
  entries: ListFilesEntry[];
  truncated: boolean;
}> {
  const workspaceRoot = process.cwd();
  const relativePath = normalizeRelativeWorkspacePath("list_files", args?.path);
  const absolutePath = resolveWorkspacePath(
    "list_files",
    workspaceRoot,
    relativePath,
  );
  const stat = await lstat(absolutePath);
  const depth = args?.depth ?? 2;

  if (!stat.isDirectory()) {
    return {
      path: relativePath,
      depth,
      entries: [
        {
          path: relativePath,
          type: stat.isSymbolicLink() ? "symlink" : "file",
        },
      ],
      truncated: false,
    };
  }

  const entries: ListFilesEntry[] = [];
  let truncated = false;

  await walkDirectory(relativePath, absolutePath, depth, entries, () => {
    truncated = true;
  });

  return {
    path: relativePath,
    depth,
    entries,
    truncated,
  };
}

async function walkDirectory(
  relativePath: string,
  absolutePath: string,
  depthRemaining: number,
  entries: ListFilesEntry[],
  onTruncated: () => void,
): Promise<void> {
  const directoryEntries = await readdir(absolutePath, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of directoryEntries) {
    if (entries.length >= MAX_ENTRIES) {
      onTruncated();
      return;
    }

    const childRelativePath =
      relativePath === "."
        ? entry.name
        : path.posix.join(relativePath.replace(/\\/g, "/"), entry.name);
    const childAbsolutePath = path.join(absolutePath, entry.name);
    const childType = entry.isSymbolicLink()
      ? "symlink"
      : entry.isDirectory()
        ? "directory"
        : "file";

    entries.push({
      path: childRelativePath,
      type: childType,
    });

    if (
      !entry.isDirectory() ||
      depthRemaining <= 0 ||
      NON_RECURSIVE_DIRECTORIES.has(entry.name)
    ) {
      continue;
    }

    await walkDirectory(
      childRelativePath,
      childAbsolutePath,
      depthRemaining - 1,
      entries,
      onTruncated,
    );

    if (entries.length >= MAX_ENTRIES) {
      onTruncated();
      return;
    }
  }
}

function parseListFilesArgs(rawArguments: string): ListFilesArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return listFilesArgsSchema.parse(parsed);
}
